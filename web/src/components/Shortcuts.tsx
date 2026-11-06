import { FolderOpen, Keyboard, Search, TerminalSquare } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import { ago } from "../lib/format";
import { GLOBAL_ID } from "../lib/project";
import { prefetchProject, useLive, useStore } from "../lib/store";
import type { LiveProject, LiveSession, ProjectInfo } from "../lib/types";
import { Popover } from "./ui/Popover";

/**
 * Every project's open sessions, read once for the whole page: the live
 * panel draws them, the shortcuts walk them and the tab title counts the
 * ones waiting on you.
 */
export const useGlobalLive = create<{ projects: LiveProject[] | null }>(() => ({ projects: null }));

/** Keeps useGlobalLive fresh; mounted once, whatever the page shows. */
export function GlobalLiveFeed() {
  const live = useLive(() => api.globalLive(), ["projects", "sessions", "interactions", "channels"]);
  useEffect(() => {
    if (live.data) useGlobalLive.setState({ projects: live.data });
  }, [live.data]);
  return null;
}

/** Waiting on you: a question open, or Claude stopped for an answer. */
export const isWaiting = (session: LiveSession) => session.status === "waiting" || session.openInteractions > 0;

/** The open sessions in the live panel's order, with their project. */
function openSessions(projects: LiveProject[]): Array<{ project: LiveProject; session: LiveSession }> {
  return projects.flatMap((project) => project.open.map((session) => ({ project, session })));
}

/** How many sessions of every project wait on you; the tab title leads with it. */
export function useWaitingCount(): number {
  return useGlobalLive((state) => (state.projects ? openSessions(state.projects).filter((item) => isWaiting(item.session)).length : 0));
}

/** The sessions shown lately, newest last, for Alt+` (back to the one before). */
const visited: Array<{ projectId: string; id: string }> = [];

function openSession(projectId: string, id: string): void {
  useStore.getState().openSessionIn(projectId, id);
}

export const SHORTCUTS: Array<{ keys: string; what: string }> = [
  { keys: "Ctrl+K", what: "Find and open a session or project" },
  { keys: "Alt+1 … Alt+9", what: "Open the 1st … 9th session of the Open sessions panel" },
  { keys: "Alt+`", what: "Back to the session shown before" },
  { keys: "Alt+W", what: "Next session waiting on you, in any project" },
  { keys: "Ctrl+`", what: "Show the sidebar's live sessions" },
  { keys: "Ctrl+Enter", what: "Send now (Claude Code's Ctrl+X Ctrl+S), in a terminal" },
  { keys: "Ctrl+F", what: "Find in the terminal's scrollback" },
  { keys: "Ctrl+C", what: "Copy the selection in a terminal (without one, ^C goes to Claude)" },
  { keys: "Right click", what: "Copy the selection in a terminal" },
  { keys: "Ctrl+V", what: "Paste into a terminal" },
  { keys: "Ctrl+click", what: "Open a file path or link printed in a terminal" },
  { keys: "Drop a file", what: "On a terminal: saves it and pastes its path" },
];

/**
 * The page-wide keys, caught before a terminal or editor sees them. Mounted
 * once by App, on the global page as well as in a project.
 */
export function ShortcutKeys() {
  const projectId = useStore((state) => state.projectId);
  const view = useStore((state) => state.view);
  const windowed = useStore((state) => state.windowed);
  const [finder, setFinder] = useState(false);

  useEffect(() => {
    if (!projectId || view.kind !== "session") return;
    const last = visited[visited.length - 1];
    if (last && last.projectId === projectId && last.id === view.id) return;
    visited.push({ projectId, id: view.id });
    if (visited.length > 50) visited.shift();
  }, [projectId, view]);

  useEffect(() => {
    if (windowed) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey) return;
      const projects = useGlobalLive.getState().projects ?? [];
      const { projectId: here, view: shown } = useStore.getState();
      const claim = () => {
        event.preventDefault();
        event.stopPropagation();
      };
      if (event.ctrlKey && !event.altKey && !event.shiftKey && event.code === "KeyK") {
        claim();
        setFinder((open) => !open);
        return;
      }
      if (!event.altKey || event.ctrlKey) return;
      const digit = /^Digit([1-9])$/.exec(event.code);
      if (digit && !event.shiftKey) {
        const target = openSessions(projects)[Number(digit[1]) - 1];
        claim();
        if (target) openSession(target.project.id, target.session.id);
        return;
      }
      if (event.code === "Backquote" && !event.shiftKey) {
        claim();
        // The latest one that is not the session shown now.
        for (let index = visited.length - 1; index >= 0; index -= 1) {
          const item = visited[index];
          if (item.projectId === here && shown.kind === "session" && item.id === shown.id) continue;
          return openSession(item.projectId, item.id);
        }
        return;
      }
      if (event.code === "KeyW" && !event.shiftKey) {
        claim();
        const waiting = openSessions(projects).filter((item) => isWaiting(item.session));
        if (!waiting.length) return useStore.getState().notify("No session is waiting on you.");
        // The one after the session shown, round the list.
        const at = waiting.findIndex((item) => item.project.id === here && shown.kind === "session" && item.session.id === shown.id);
        const next = waiting[(at + 1) % waiting.length];
        openSession(next.project.id, next.session.id);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [windowed]);

  return finder ? <QuickSwitcher onClose={() => setFinder(false)} /> : null;
}

type Item =
  | { kind: "session"; key: string; project: { id: string; name: string }; session: LiveSession; open: boolean; label: string }
  | { kind: "project"; key: string; project: ProjectInfo; label: string };

/** How well text matches what was typed: higher is better, null not at all. */
function score(text: string, query: string): number | null {
  if (!query) return 0;
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase().trim();
  const at = haystack.indexOf(needle);
  if (at !== -1) return 1000 - at;
  // Every word somewhere, in any order.
  const words = needle.split(/\s+/).filter(Boolean);
  if (words.every((word) => haystack.includes(word))) return 500;
  // The letters in order, as a fuzzy finder does.
  let index = 0;
  for (const char of haystack) if (char === needle[index]) index += 1;
  return index === needle.length ? 100 : null;
}

/** Ctrl+K: type to find any open or recent session, or a project, and open it. */
function QuickSwitcher({ onClose }: { onClose: () => void }) {
  const projects = useGlobalLive((state) => state.projects) ?? [];
  const [all, setAll] = useState<ProjectInfo[]>([]);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const before = useRef<Element | null>(document.activeElement);

  useEffect(() => {
    input.current?.focus();
    void api.projects().then(setAll, () => undefined);
  }, []);

  const items = useMemo<Item[]>(() => {
    const found: Item[] = [];
    for (const project of projects) {
      for (const session of project.open) found.push({ kind: "session", key: `o:${project.id}:${session.id}`, project, session, open: true, label: `${session.title} ${project.name}` });
    }
    for (const project of projects) {
      for (const session of project.recent) found.push({ kind: "session", key: `r:${project.id}:${session.id}`, project, session, open: false, label: `${session.title} ${project.name}` });
    }
    for (const project of all) found.push({ kind: "project", key: `p:${project.id}`, project, label: `${project.name} ${project.root}` });
    return found
      .map((item, order) => ({ item, order, score: score(item.label, query) }))
      .filter((entry) => entry.score !== null)
      .sort((a, b) => b.score! - a.score! || a.order - b.order)
      .slice(0, 50)
      .map((entry) => entry.item);
  }, [projects, all, query]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const close = () => {
    onClose();
    (before.current as HTMLElement | null)?.focus?.();
  };
  const pick = (item: Item | undefined) => {
    if (!item) return;
    onClose();
    if (item.kind === "session") openSession(item.project.id, item.session.id);
    else useStore.getState().openProject(item.project.id);
  };

  return (
    <div className="fixed inset-0 z-[65] flex items-start justify-center bg-foreground/30 px-4 pt-[12vh] animate-in fade-in-0" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <div role="dialog" aria-label="Open a session or project" className="w-full max-w-lg overflow-hidden rounded-xl border bg-card shadow-2xl">
        <div className="flex items-center gap-2 border-b px-3 py-2.5">
          <Search size={14} className="shrink-0 text-muted-foreground" />
          <input
            ref={input}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Open a session or project..."
            aria-label="Find a session or project"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                close();
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive((index) => Math.min(items.length - 1, index + 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((index) => Math.max(0, index - 1));
              } else if (event.key === "Enter") {
                event.preventDefault();
                pick(items[active]);
              }
            }}
            className="min-w-0 flex-1 bg-transparent text-sm focus:outline-none"
          />
          <kbd className="rounded border px-1 text-[10px] text-muted-foreground">Esc</kbd>
        </div>
        <div ref={list} className="max-h-[50vh] overflow-y-auto p-1">
          {!items.length && <div className="px-3 py-4 text-xs text-muted-foreground">Nothing matches.</div>}
          {items.map((item, index) => (
            <button
              key={item.key}
              data-index={index}
              onMouseMove={() => setActive(index)}
              onMouseEnter={() => item.project.id !== GLOBAL_ID && prefetchProject(item.project.id)}
              onClick={() => pick(item)}
              className={cn("flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs", index === active ? "bg-primary/15" : "hover:bg-muted")}
            >
              {item.kind === "session" ? (
                <TerminalSquare size={13} className={cn("shrink-0", item.open && isWaiting(item.session) ? "text-severity-warning" : item.open ? "text-success" : "text-muted-foreground")} />
              ) : (
                <FolderOpen size={13} className="shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1 truncate">{item.kind === "session" ? item.session.title : item.project.name}</span>
              <span className="shrink-0 truncate text-[10px] text-muted-foreground">
                {item.kind === "session"
                  ? `${item.project.name} · ${item.open ? (isWaiting(item.session) ? "waiting" : item.session.live ? "open" : "stopped") : item.session.lastAt ? ago(item.session.lastAt) : "recent"}`
                  : "project"}
              </span>
            </button>
          ))}
        </div>
        <div className="flex gap-3 border-t px-3 py-1.5 text-[10px] text-muted-foreground">
          <span>↑↓ to move</span>
          <span>Enter to open</span>
          <span>A stopped session resumes when opened</span>
        </div>
      </div>
    </div>
  );
}

/** Next to the live panel's switch: every key the hub answers to. */
export function ShortcutsButton() {
  return (
    <Popover
      align="start"
      className="w-[22rem] max-w-[calc(100vw-1rem)] p-2"
      trigger={
        <button title="Keyboard shortcuts" aria-label="Keyboard shortcuts" className="self-center rounded p-0.5 text-muted-foreground/70 hover:bg-muted hover:text-foreground">
          <Keyboard size={13} />
        </button>
      }
    >
      <div className="px-1 pb-1.5 text-xs font-semibold">Keyboard shortcuts</div>
      <div className="space-y-0.5">
        {SHORTCUTS.map((shortcut) => (
          <div key={shortcut.keys} className="flex items-start gap-3 rounded px-1 py-1 text-[11px]">
            <kbd className="w-24 shrink-0 whitespace-nowrap rounded border bg-muted px-1 py-0.5 text-center font-mono text-[10px]">{shortcut.keys}</kbd>
            <span className="text-muted-foreground">{shortcut.what}</span>
          </div>
        ))}
      </div>
    </Popover>
  );
}
