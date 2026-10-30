import {
  ArrowRight,
  Bell,
  BookText,
  Bot,
  CalendarClock,
  ExternalLink,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Command,
  LayoutDashboard,
  Menu,
  MoreHorizontal,
  Pencil,
  Play,
  MessageSquareText,
  Layers,
  Plug,
  PlugZap,
  Plus,
  Puzzle,
  Radio,
  Search,
  SlidersHorizontal,
  Sparkles,
  Tags,
  Trash2,
  Webhook,
  Wrench,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../lib/cn";
import { ago, compact, totalTokens } from "../lib/format";
import { api } from "../lib/api";
import { attempt, openWindow, useStore, type Page } from "../lib/store";
import type { PurposeKind, Session } from "../lib/types";
import { usePurpose } from "../lib/usePurpose";
import { FileTree } from "./FileTree";
import { LogoLink, ProjectSwitcher, TitleLink } from "./Projects";
import { useSessionActions } from "./SessionActions";
import { Button } from "./ui/Button";
import { Input } from "./ui/Input";
import { Popover } from "./ui/Popover";
import { Tooltip } from "./ui/Tooltip";

interface NavItem {
  page: Page;
  label: string;
  icon: typeof Bell;
}

/** Operation is what is happening, Project is what sessions are made of, Settings is how the hub behaves. */
export const NAV_GROUPS: Array<{ id: string; label: string; items: NavItem[] }> = [
  {
    id: "operation",
    label: "Operation",
    items: [
      { page: "overview", label: "Overview", icon: LayoutDashboard },
      { page: "inbox", label: "Inbox", icon: Bell },
      { page: "automation", label: "Automation", icon: CalendarClock },
    ],
  },
  {
    id: "project",
    label: "Project",
    items: [
      { page: "instructions", label: "Instructions", icon: BookText },
      { page: "agents", label: "Agents", icon: Bot },
      { page: "skills", label: "Skills", icon: Sparkles },
      { page: "commands", label: "Commands", icon: Command },
      { page: "mcp-servers", label: "MCP servers", icon: Plug },
      { page: "hooks", label: "Hooks", icon: Webhook },
      { page: "plugins", label: "Plugins", icon: Puzzle },
    ],
  },
  {
    id: "settings",
    label: "Settings",
    items: [
      { page: "claude-settings", label: "Claude settings", icon: SlidersHorizontal },
      { page: "channels", label: "Channels", icon: Radio },
      { page: "hub-prompts", label: "Hub prompts", icon: MessageSquareText },
      { page: "mcp-suggestions", label: "MCP suggestions", icon: PlugZap },
      { page: "presets", label: "Toolset presets", icon: Layers },
      { page: "categories", label: "Task categories", icon: Tags },
    ],
  },
];

export function StatusDot({ session }: { session: Session }) {
  const tone =
    session.status === "waiting"
      ? "bg-severity-warning animate-status-pulse"
      : session.status === "running"
        ? "bg-success animate-status-pulse"
        : session.status === "done"
          ? "border border-success bg-transparent"
          : "bg-muted-foreground/40";
  return <span className={cn("inline-block h-2 w-2 shrink-0 rounded-full", tone)} />;
}

const ORIGIN_LABEL: Record<Session["origin"], string> = {
  manual: "hub",
  cron: "cron",
  webhook: "webhook",
  queue: "queue",
  external: "terminal",
};

const FOLDED_KEY = "clauder-hub:folded-groups";
const TAB_KEY = "clauder-hub:sidebar-tab";
const HIDE_TASKS_KEY = "clauder-hub:history-hide-tasks";
/** Raised by App on Ctrl+`: show the Sessions tab and its live sessions. */
export const FOCUS_SESSIONS_EVENT = "clauder:focus-sessions";

/** A checkbox's state, remembered per browser. */
function useStoredFlag(key: string, initial: boolean): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored === null ? initial : stored === "1";
    } catch {
      return initial;
    }
  });
  const set = (next: boolean) => {
    setValue(next);
    try {
      localStorage.setItem(key, next ? "1" : "0");
    } catch {
      // The choice just does not persist.
    }
  };
  return [value, set];
}

type SidebarTab = "sessions" | "workspace" | "files";

/** Which of the sidebar tabs is showing, remembered per browser. */
function useSidebarTab(): [SidebarTab, (tab: SidebarTab) => void] {
  const [tab, setTab] = useState<SidebarTab>(() => {
    try {
      const stored = localStorage.getItem(TAB_KEY);
      return stored === "workspace" || stored === "files" ? stored : "sessions";
    } catch {
      return "sessions";
    }
  });
  const choose = (next: SidebarTab) => {
    setTab(next);
    try {
      localStorage.setItem(TAB_KEY, next);
    } catch {
      // The preference just does not persist.
    }
  };
  return [tab, choose];
}

function useFolded(): [Set<string>, (id: string) => void] {
  const [folded, setFolded] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(FOLDED_KEY) ?? "[]"));
    } catch {
      return new Set();
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(FOLDED_KEY, JSON.stringify([...folded]));
    } catch {
      // The preference just does not persist.
    }
  }, [folded]);
  const toggle = (id: string) =>
    setFolded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return [folded, toggle];
}

/**
 * A plain `claude` at the prompt, with the user's own settings, straight
 * into its terminal. Sized to the panel it will fill (the window less
 * `beside`, what the sidebar takes), so the TUI does not redraw at another
 * width when the page attaches.
 */
function useNewSession(beside: number): { starting: boolean; newSession: () => Promise<void> } {
  const go = useStore((state) => state.go);
  const [starting, setStarting] = useState(false);
  const newSession = async () => {
    if (starting) return;
    setStarting(true);
    const cols = Math.max(80, Math.floor((window.innerWidth - beside - 40) / 7.8));
    const rows = Math.max(24, Math.floor((window.innerHeight - 140) / 17));
    const started = await attempt(() => api.startSession({ cols, rows }));
    setStarting(false);
    if (!started) return;
    await useStore.getState().refreshSessions();
    go({ kind: "session", id: started.sessionId });
  };
  return { starting, newSession };
}

const HUB_TASKS: Array<{ kind: PurposeKind; label: string; icon: typeof Bell }> = [
  // Not tied to one kind of change: ask the hub about anything in its configuration.
  { kind: "hub", label: "Hub task", icon: Wrench },
  { kind: "create-job", label: "Create a job", icon: CalendarClock },
  { kind: "queue-run", label: "Queue a run", icon: Play },
  { kind: "create-category", label: "New task category", icon: Tags },
  { kind: "create-preset", label: "New toolset preset", icon: Layers },
  { kind: "create-channel", label: "Add a channel", icon: Radio },
];

/**
 * New session as a split button: the main part starts a plain session, the
 * arrow at its end offers the same or a hub task (a Claude session for one
 * configuration job).
 */
function NewSessionButton({ beside, size = "sm", full = false }: { beside: number; size?: "sm" | "md"; full?: boolean }) {
  const { starting, newSession } = useNewSession(beside);
  const { starting: startingTask, start } = usePurpose();
  const [open, setOpen] = useState(false);
  const busy = starting || startingTask;
  const pick = (run: () => Promise<void>) => {
    setOpen(false);
    void run();
  };
  return (
    <div className={cn("flex", full && "w-full")}>
      <Button variant="primary" size={size} className="flex-1 rounded-r-none" disabled={busy} onClick={() => void newSession()} aria-label="New session">
        <Plus size={size === "md" ? 14 : 13} /> {busy ? "Starting..." : "New session"}
      </Button>
      <Popover
        open={open}
        onOpenChange={setOpen}
        align="end"
        className="w-56 p-1"
        trigger={
          <Button variant="primary" size={size} className="rounded-l-none border-l border-primary-foreground/25 px-2" disabled={busy} aria-label="More ways to start" title="Plain session or hub task">
            <ChevronDown size={14} />
          </Button>
        }
      >
        <button className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted" onClick={() => pick(newSession)}>
          <Plus size={13} /> New session
        </button>
        <div className="mx-2 mb-0.5 mt-1.5 border-t pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Hub task</div>
        {HUB_TASKS.map((task) => (
          <button key={task.kind} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted" onClick={() => pick(() => start(task.kind))}>
            <task.icon size={13} className="text-primary" /> {task.label}
          </button>
        ))}
      </Popover>
    </div>
  );
}

/** The top bar of a narrow window, whose sidebar is a drawer: open it, see which project, start a session. */
export function MobileBar({ onMenu }: { onMenu: () => void }) {
  const health = useStore((state) => state.health);
  return (
    <div className="flex shrink-0 items-center gap-2 border-b px-2 py-2">
      <Button variant="ghost" size="icon" onClick={onMenu} aria-label="Open menu" title="Menu">
        <Menu size={16} />
      </Button>
      <LogoLink />
      <div className="min-w-0 flex-1">
        <TitleLink />
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[11px] text-muted-foreground">{health?.project ?? "..."}</span>
          <ProjectSwitcher />
        </div>
      </div>
      <NewSessionButton beside={0} />
    </div>
  );
}

/**
 * The sidebar, docked beside the page or, with `drawer`, inside the drawer of
 * a narrow window, where `onToggle` closes the drawer instead of collapsing.
 */
export function Sidebar({ width, collapsed, onToggle, drawer = false }: { width: number | string; collapsed: boolean; onToggle: () => void; drawer?: boolean }) {
  const { sessions, open, view, go, health } = useStore();
  const [query, setQuery] = useState("");
  const [folded, toggleGroup] = useFolded();
  const [tab, setTab] = useSidebarTab();
  const { starting, newSession } = useNewSession(drawer ? 0 : collapsed ? 48 : Number(width));

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? sessions.filter((item) => `${item.title} ${item.firstPrompt ?? ""} ${item.id}`.toLowerCase().includes(needle)) : sessions;
  }, [sessions, query]);
  const live = filtered.filter((item) => item.live);
  const rest = filtered.filter((item) => !item.live);
  const [hideTasks, setHideTasks] = useStoredFlag(HIDE_TASKS_KEY, true);
  const history = hideTasks ? rest.filter((item) => !item.purpose) : rest;

  // Ctrl+` (raised by App) brings the Sessions tab up and makes the live sessions light up.
  const [flash, setFlash] = useState(0);
  const liveRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const focus = () => {
      setTab("sessions");
      setFlash((count) => count + 1);
      window.setTimeout(() => liveRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 50);
    };
    window.addEventListener(FOCUS_SESSIONS_EVENT, focus);
    return () => window.removeEventListener(FOCUS_SESSIONS_EVENT, focus);
  }, [setTab]);
  const isActive = (page: Page) => view.kind === "page" && view.page === page;

  if (collapsed) {
    return (
      <aside className="flex w-12 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r py-3">
        <LogoLink className="mb-2" />
        <Tooltip content="New session" side="right" asChild>
          <Button variant="primary" size="icon" disabled={starting} onClick={() => void newSession()}>
            <Plus size={14} />
          </Button>
        </Tooltip>
        {NAV_GROUPS.map((group) => (
          <div key={group.id} className="flex flex-col items-center gap-1 border-t pt-1">
            {group.items.map((item) => (
              <Tooltip key={item.page} content={`${group.label} · ${item.label}`} side="right" asChild>
                <Button variant="ghost" size="icon" className={cn(isActive(item.page) && "bg-muted text-foreground")} onClick={() => go({ kind: "page", page: item.page })}>
                  <item.icon size={15} />
                </Button>
              </Tooltip>
            ))}
          </div>
        ))}
        <div className="flex-1" />
        <Button variant="ghost" size="icon" onClick={onToggle} aria-label="Expand sidebar">
          <ChevronsRight size={15} />
        </Button>
      </aside>
    );
  }

  return (
    <aside className="flex shrink-0 flex-col" style={{ width }}>
      <div className="flex items-center gap-2 px-3 pb-2 pt-3">
        <LogoLink />
        <div className="min-w-0">
          <TitleLink />
          <div className="flex min-w-0 items-center gap-1.5">
            <Tooltip content={health?.projectRoot} wide className="min-w-0">
              <div className="truncate text-[11px] text-muted-foreground">{health?.project ?? "..."}</div>
            </Tooltip>
            <ProjectSwitcher />
          </div>
        </div>
        {drawer ? (
          <Button variant="ghost" size="icon" className="ml-auto" onClick={onToggle} aria-label="Close menu">
            <X size={15} />
          </Button>
        ) : (
          <Button variant="ghost" size="icon" className="ml-auto" onClick={onToggle} aria-label="Collapse sidebar">
            <ChevronsLeft size={15} />
          </Button>
        )}
      </div>

      <div className="px-3 pb-2">
        <NewSessionButton beside={collapsed ? 48 : typeof width === "number" ? width : 280} size="md" full />
      </div>

      {/* Three tabs: the sessions themselves, everything around them, and the project's files. */}
      <div className="mx-3 mb-2 flex rounded-md bg-muted p-0.5">
        {(
          [
            ["sessions", "Sessions", null],
            ["workspace", "Workspace", open.length ? String(open.length) : null],
            ["files", "Files", null],
          ] as Array<[SidebarTab, string, string | null]>
        ).map(([key, label, count]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={cn(
              "flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1 text-xs transition-colors",
              tab === key ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
            {/* Something running is enough to know; the list says how many. */}
            {key === "sessions" && live.length > 0 && <span className="h-1.5 w-1.5 rounded-full bg-success" title={`${live.length} running`} />}
            {count && (
              <span className={cn("rounded-full px-1.5 text-[10px] font-semibold", key === "workspace" ? "bg-severity-warning text-background" : "bg-success/20 text-success")}>
                {count}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {tab === "files" ? (
          <FileTree />
        ) : tab === "workspace" ? (
          <nav className="px-2">
            {NAV_GROUPS.map((group) => {
              const isFolded = folded.has(group.id);
              const holdsActive = group.items.some((item) => isActive(item.page));
              return (
                <div key={group.id} className="pb-1">
                  <button
                    onClick={() => toggleGroup(group.id)}
                    className="flex w-full items-center gap-1 px-2 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
                  >
                    {isFolded ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
                    {group.label}
                    {isFolded && group.id === "operation" && open.length > 0 && <span className="ml-auto rounded-full bg-severity-warning px-1.5 text-[10px] text-background">{open.length}</span>}
                  </button>
                  {(!isFolded || holdsActive) &&
                    group.items
                      .filter((item) => !isFolded || isActive(item.page))
                      .map((item) => (
                        <button
                          key={item.page}
                          onClick={() => go({ kind: "page", page: item.page })}
                          className={cn(
                            "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors",
                            isActive(item.page) ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                          )}
                        >
                          <item.icon size={14} />
                          {item.label}
                          {item.page === "inbox" && open.length > 0 && (
                            <span className="ml-auto rounded-full bg-severity-warning px-1.5 text-[10px] font-semibold text-background">{open.length}</span>
                          )}
                        </button>
                      ))}
                </div>
              );
            })}
          </nav>
        ) : (
          <>
            {/* Stays put while the list scrolls under it. */}
            <div className="sticky top-0 z-10 bg-background px-3 pb-1">
              <div className="relative">
                <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search sessions" className="pl-6" />
              </div>
            </div>
            <div className="px-2">
              <div ref={liveRef}>
                <SessionGroup title={`Live (${live.length})`} sessions={live} flash={flash} />
              </div>
              <SessionGroup
                title={`History (${history.length})`}
                sessions={history}
                action={
                  <label className="flex cursor-pointer select-none items-center gap-1" title="Hide the hub's own configuration sessions">
                    <input type="checkbox" className="h-3 w-3 accent-[hsl(var(--primary))]" checked={hideTasks} onChange={(event) => setHideTasks(event.target.checked)} />
                    Hide hub tasks
                  </label>
                }
              />
              {!filtered.length && <div className="px-2 pt-3 text-xs text-muted-foreground">{query ? "No match." : "No sessions yet. Start one above."}</div>}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}

/** The right-click menu on a session in the list; on touch, a long press or the row's "..." button. */
function SessionMenu({ session, x, y, onClose }: { session: Session; x: number; y: number; onClose: () => void }) {
  const go = useStore((state) => state.go);
  const actions = useSessionActions();

  useEffect(() => {
    const close = () => onClose();
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("pointerdown", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const item = (label: string, icon: typeof Bell, run: () => void, options: { disabled?: boolean; danger?: boolean; hint?: string } = {}) => {
    const Icon = icon;
    return (
      <button
        disabled={options.disabled}
        title={options.hint}
        // Pointer-down closes the menu, so the action runs on that, before the window listener.
        onPointerDown={(event) => {
          event.stopPropagation();
          if (options.disabled) return;
          onClose();
          run();
        }}
        className={cn(
          "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs disabled:cursor-not-allowed disabled:opacity-40",
          options.danger ? "text-severity-critical hover:bg-destructive/15" : "hover:bg-muted",
        )}
      >
        <Icon size={13} />
        {label}
      </button>
    );
  };

  return (
    <div
      role="menu"
      className="fixed z-50 w-48 rounded-lg border bg-card p-1 shadow-lg"
      // Kept inside the window when opened near its bottom or right edge.
      style={{ left: Math.min(x, window.innerWidth - 200), top: Math.min(y, window.innerHeight - 170) }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {item("Open", ArrowRight, () => go({ kind: "session", id: session.id }))}
      {item("Open in new window", ExternalLink, () => openWindow({ kind: "session", id: session.id }))}
      {item("Rename", Pencil, () => void actions.rename(session))}
      <div className="my-1 border-t" />
      {item("Delete permanently", Trash2, () => void actions.remove(session), {
        danger: true,
        hint: session.live ? "Stops it first" : undefined,
      })}
    </div>
  );
}

function SessionGroup({ title, sessions, action, flash = 0 }: { title: string; sessions: Session[]; action?: React.ReactNode; flash?: number }) {
  const { view, go } = useStore();
  const [menu, setMenu] = useState<{ session: Session; x: number; y: number } | null>(null);
  // A touch held still for half a second opens the menu, and the click that follows does not navigate.
  const press = useRef<{ timer?: number; fired: boolean }>({ fired: false });
  const startPress = (session: Session, event: React.PointerEvent) => {
    press.current.fired = false;
    if (event.pointerType !== "touch") return;
    const { clientX: x, clientY: y } = event;
    window.clearTimeout(press.current.timer);
    press.current.timer = window.setTimeout(() => {
      press.current.fired = true;
      setMenu({ session, x, y });
    }, 500);
  };
  const endPress = () => window.clearTimeout(press.current.timer);
  if (!sessions.length && !action) return null;
  return (
    // Keyed by the flash count, so each Ctrl+` replays the highlight from the start.
    <div key={flash} className={cn("mt-3 rounded-md", flash > 0 && "sessions-flash")}>
      {menu && <SessionMenu {...menu} onClose={() => setMenu(null)} />}
      <div className="flex items-center justify-between gap-2 px-2 pb-1 text-[10px] text-muted-foreground">
        <span>{title}</span>
        {action}
      </div>
      <div className="space-y-0.5">
        {sessions.map((session) => {
          const active = view.kind === "session" && view.id === session.id;
          return (
            <div key={session.id} className="relative">
              <button
                onClick={() => !press.current.fired && go({ kind: "session", id: session.id })}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMenu({ session, x: event.clientX, y: event.clientY });
                }}
                onPointerDown={(event) => startPress(session, event)}
                onPointerUp={endPress}
                onPointerLeave={endPress}
                onPointerCancel={endPress}
                className={cn(
                  "block w-full select-none rounded-md px-2 py-1.5 pr-8 text-left transition-colors [-webkit-touch-callout:none] md:select-auto md:pr-2",
                  active ? "bg-muted" : "hover:bg-muted/60",
                )}
              >
                <div className="flex items-center gap-2">
                  <StatusDot session={session} />
                  <span className="min-w-0 flex-1 truncate text-xs">{session.title}</span>
                  {/* A configuration session (hub task), told apart from real work at a glance. */}
                  {session.purpose && (
                    <span className="flex shrink-0 items-center gap-0.5 rounded bg-primary/15 px-1 text-[9px] font-medium text-primary" title={`Hub task: ${session.purpose.title}`}>
                      <Wrench size={9} /> task
                    </span>
                  )}
                  {session.openInteractions > 0 && <span className="grid h-4 min-w-[1rem] shrink-0 place-items-center rounded-full bg-severity-warning px-1 text-[10px] font-semibold leading-none text-background">{session.openInteractions}</span>}
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 pl-4 text-[10px] text-muted-foreground">
                  <span>{ORIGIN_LABEL[session.origin]}</span>
                  <span>·</span>
                  <span>{ago(session.lastAt)}</span>
                  {session.tokens && (
                    <>
                      <span>·</span>
                      <span>{compact(totalTokens(session.tokens))} tok</span>
                    </>
                  )}
                  {session.subagentCount ? (
                    <>
                      <span>·</span>
                      <span>{session.subagentCount} agents</span>
                    </>
                  ) : null}
                </div>
              </button>
              {/* Touch has no right click: the same menu from a button of its own, shown only in the drawer. */}
              <button
                aria-label="Session actions"
                title="Session actions"
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  setMenu({ session, x: rect.right - 192, y: rect.bottom + 4 });
                }}
                className="absolute right-1 top-1 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground md:hidden"
              >
                <MoreHorizontal size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
