import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { filesApi } from "../lib/filesApi";
import { openedFromTerminal, useOpenFiles } from "../lib/openFiles";
import { projectApi } from "../lib/project";
import { useStore } from "../lib/store";

/** A path with a folder in it and a file name with an extension, optionally :line[:col]; absolute (C:\ or /) or relative. */
const PATH = /(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|[\\/])?(?:[\w.@-]+[\\/])+[\w.@-]+\.[A-Za-z0-9]{1,10}(?::\d+(?::\d+)?)?/g;

/** The project-relative path a terminal link points at, or null when it is outside the project. */
function projectPath(link: string): string | null {
  let target = link;
  if (/^file:/i.test(target)) {
    try {
      target = decodeURIComponent(new URL(target).pathname).replace(/^\/([A-Za-z]:)/, "$1");
    } catch {
      return null;
    }
  }
  target = target.replace(/\\/g, "/").replace(/:\d+(?::\d+)?$/, "");
  const root = useStore.getState().health?.projectRoot.replace(/\\/g, "/").replace(/\/$/, "");
  if (/^([A-Za-z]:)?\//.test(target)) {
    if (!root || !target.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return null;
    target = target.slice(root.length + 1);
  }
  target = target.replace(/^(\.\/)+/, "");
  return target && !target.startsWith("../") ? target : null;
}

/** An absolute path outside the project (a temp folder, say), without its :line:col; null for anything else. */
function localPath(link: string): string | null {
  if (projectPath(link)) return null;
  const target = link.replace(/:\d+(?::\d+)?$/, "");
  return /^([A-Za-z]:[\\/]|\/)/.test(target) ? target : null;
}

const seen = new Map<string, { at: number; exists: Promise<boolean> }>();
/** Only a file that is there gets a link; asked once per half minute per path. */
function fileExists(link: string): Promise<boolean> {
  const path = projectPath(link);
  const local = path ? null : localPath(link);
  const key = path ?? local;
  if (!key) return Promise.resolve(false);
  const hit = seen.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.exists;
  const exists = (
    path
      ? filesApi.stat(path)
      : fetch(`/api/local-file/stat?path=${encodeURIComponent(local!)}`).then((response) => response.json() as Promise<{ exists: boolean }>)
  ).then((stat) => stat.exists, () => false);
  seen.set(key, { at: Date.now(), exists });
  return exists;
}

/**
 * The text a row is part of, with the cell of every character. Claude Code
 * breaks a long line itself, ending a row at (or a cell short of) the last column and indenting
 * the next one, so a long path runs over rows that the terminal does not
 * know belong together: a full row joins the next without its indent. A row
 * the terminal itself wrapped (after a resize reflows them) keeps that indent
 * in it too, so it goes as well.
 */
function logicalLine(term: Terminal, row: number): { text: string; cells: Array<{ x: number; y: number }> } {
  const buffer = term.buffer.active;
  const textOf = (y: number) => buffer.getLine(y)?.translateToString(true) ?? "";
  const joins = (y: number) => {
    const next = buffer.getLine(y + 1);
    return Boolean(next && (next.isWrapped || (textOf(y).length >= term.cols - 2 && /^ {1,4}\S/.test(textOf(y + 1)))));
  };
  let first = row;
  while (first > 0 && joins(first - 1)) first -= 1;
  let last = row;
  while (last < buffer.length - 1 && joins(last)) last += 1;
  let text = "";
  const cells: Array<{ x: number; y: number }> = [];
  for (let y = first; y <= last; y += 1) {
    const line = textOf(y);
    const skip = y > first ? (/^ {1,4}(?=\S)/.exec(line)?.[0].length ?? 0) : 0;
    for (let x = skip; x < line.length; x += 1) cells.push({ x: x + 1, y: y + 1 });
    text += line.slice(skip);
  }
  return { text, cells };
}

/**
 * The paths on one terminal line, with their columns. A path under the
 * project root may hold spaces ("C:\Source code\..."), so the root is looked
 * for first; elsewhere a space ends a path. Text inside a web address is not one.
 */
function pathsIn(text: string): Array<{ index: number; text: string }> {
  const found: Array<{ index: number; text: string }> = [];
  const root = useStore.getState().health?.projectRoot.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
  const flat = text.replace(/\\/g, "/").toLowerCase();
  for (let at = root ? flat.indexOf(`${root}/`) : -1; root && at !== -1; at = flat.indexOf(`${root}/`, at + 1)) {
    const rest = /^[^\s:*?"<>|()]+(?::\d+(?::\d+)?)?/.exec(text.slice(at + root.length + 1));
    if (rest) found.push({ index: at, text: text.slice(at, at + root.length + 1 + rest[0].length) });
  }
  for (const match of text.matchAll(PATH)) {
    const index = match.index!;
    if (found.some((item) => index < item.index + item.text.length && item.index < index + match[0].length)) continue;
    if (/[a-z][\w+.-]*:\/{1,2}\S*$/i.test(text.slice(0, index))) continue;
    found.push({ index, text: match[0] });
  }
  return found;
}

/**
 * Ctrl (Cmd on a Mac) and click, as in a desktop terminal: the file opens in the hub's editor; closing it comes back here.
 * A file outside the project opens read only in a browser tab of its own (an image shows as one).
 */
function openLink(event: MouseEvent, link: string, terminalId: string): boolean {
  if (!event.ctrlKey && !event.metaKey) return false;
  const path = projectPath(link);
  const local = path ? null : localPath(link);
  if (local) {
    window.open(`/api/local-file?path=${encodeURIComponent(local)}`, "_blank", "noopener");
    return true;
  }
  if (!path) return false;
  const { sessions, go } = useStore.getState();
  const session = sessions.find((item) => item.terminalId === terminalId);
  if (session) openedFromTerminal(path, session.id);
  useOpenFiles.getState().pin(path);
  go({ kind: "file", path });
  return true;
}

type TerminalState = "connecting" | "open" | "closed";

/**
 * One terminal kept in the page: its xterm, its socket, and the element it
 * draws into. Leaving the view only takes the element off the page; output
 * keeps coming in, so going back (to another session, another project, and
 * back) shows it at once with its scrollback, without a replay.
 */
interface Kept {
  terminalId: string;
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  element: HTMLDivElement;
  socket: WebSocket;
  state: TerminalState;
  ended: boolean;
  mounted: boolean;
  usedAt: number;
  opened: boolean;
  listeners: Set<() => void>;
  /** Set by the view showing it. */
  onExit?: () => void;
  onFind?: () => void;
  send: (message: unknown) => void;
  sendSize: () => void;
  copy: () => boolean;
  dispose: () => void;
}

/** How many terminals stay alive off screen; the least recently shown goes first. */
const KEEP = 8;
const kept = new Map<string, Kept>();

function setState(entry: Kept, state: TerminalState): void {
  entry.state = state;
  for (const listener of entry.listeners) listener();
}

/** Drops what is off screen beyond KEEP, and anything off screen whose terminal is gone. */
function prune(): void {
  const idle = [...kept.values()].filter((entry) => !entry.mounted);
  for (const entry of idle) if (entry.ended || entry.state === "closed") entry.dispose();
  const left = [...kept.values()].filter((entry) => !entry.mounted).sort((a, b) => a.usedAt - b.usedAt);
  while (kept.size > KEEP && left.length) left.shift()!.dispose();
}

function keep(terminalId: string): Kept {
  const existing = kept.get(terminalId);
  if (existing && existing.state !== "closed") return existing;
  existing?.dispose();

  const term = new Terminal({
    cursorBlink: true,
    fontFamily: 'ui-monospace, "Cascadia Mono", Consolas, SFMono-Regular, Menlo, monospace',
    fontSize: 13,
    scrollback: 10_000,
    allowProposedApi: true,
    // A glyph from a fallback font that is wider than its cell is squeezed into it, not drawn over the next one.
    rescaleOverlappingGlyphs: true,
    // Links Claude prints itself (OSC 8): a file in the project opens in the hub, a web link in a new tab.
    linkHandler: {
      allowNonHttpProtocols: true,
      activate: (event, uri) => {
        if (/^https?:/i.test(uri)) window.open(uri, "_blank", "noopener");
        else openLink(event, uri, terminalId);
      },
    },
    theme: {
      background: "#141413",
      foreground: "#f5f4ee",
      cursor: "#d77757",
      selectionBackground: "#d7775755",
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());
  const search = new SearchAddon();
  term.loadAddon(search);
  // File paths printed as plain text; one inside a web address is the web link's.
  const pathLinks = term.registerLinkProvider({
    provideLinks: (y, callback) => {
      const { text, cells } = logicalLine(term, y - 1);
      // The paths on this row, a long one carried over from the row before or onto the next included.
      const candidates = pathsIn(text).filter(
        (item) => (projectPath(item.text) || localPath(item.text)) && cells.slice(item.index, item.index + item.text.length).some((cell) => cell.y === y),
      );
      if (!candidates.length) return callback(undefined);
      void Promise.all(candidates.map((item) => fileExists(item.text))).then((exists) => {
        const links = candidates
          .filter((_, index) => exists[index])
          .map((item) => ({
            text: item.text,
            range: { start: cells[item.index], end: cells[item.index + item.text.length - 1] },
            activate: (event: MouseEvent, link: string) => void openLink(event, link, terminalId),
          }));
        callback(links.length ? links : undefined);
      });
    },
  });
  // Character widths as Claude Code counts them (emoji, ●, ⎿ are two cells or one the same way on both
  // sides); with xterm's default Unicode 6 table the cursor drifts and leaves letters behind on screen.
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";

  const element = document.createElement("div");
  element.className = "h-full w-full";
  const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/terminals/${terminalId}`);
  const send = (message: unknown) => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify(message));

  const entry: Kept = {
    terminalId,
    term,
    fit,
    search,
    element,
    socket,
    state: "connecting",
    ended: false,
    mounted: false,
    usedAt: Date.now(),
    opened: false,
    listeners: new Set(),
    send,
    sendSize: () => send({ type: "resize", cols: term.cols, rows: term.rows }),
    // With text selected, Ctrl+C (or Ctrl+Shift+C) copies it, as in Windows Terminal; without, ^C goes to Claude.
    copy: () => {
      const text = term.getSelection();
      if (!text) return false;
      void navigator.clipboard.writeText(text).then(
        () => useStore.getState().notify("Copied."),
        () => useStore.getState().notify("Could not copy to the clipboard.", "error"),
      );
      term.clearSelection();
      return true;
    },
    dispose: () => {
      if (kept.get(terminalId) === entry) kept.delete(terminalId);
      pathLinks.dispose();
      input.dispose();
      socket.onclose = null;
      socket.close();
      term.dispose();
      element.remove();
    },
  };

  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== "keydown" || !event.ctrlKey || event.altKey || event.metaKey) return true;
    // xterm turns Ctrl+V into ^V and cancels the key, so the browser never pastes. Let the browser
    // have it: its paste event reaches xterm, which sends the text (bracketed when Claude asks for it).
    if (event.code === "KeyV" && !event.shiftKey) return false;
    if (event.code === "KeyC" && term.hasSelection()) {
      event.preventDefault();
      entry.copy();
      return false;
    }
    // Ctrl+F searches the scrollback instead of reaching Claude (cursor right).
    if (event.code === "KeyF" && !event.shiftKey && entry.onFind) {
      event.preventDefault();
      entry.onFind();
      return false;
    }
    // Ctrl+Enter is Claude Code's Send now (Ctrl+X Ctrl+S), which the browser cannot type as a chord.
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send({ type: "input", data: "\x18\x13" });
      return false;
    }
    return true;
  });

  socket.onopen = () => {
    setState(entry, "open");
    entry.sendSize();
    if (entry.mounted) term.focus();
  };
  socket.onmessage = (event) => {
    const frame = JSON.parse(event.data) as { type: string; data?: string; code?: number };
    if (frame.type === "output" && frame.data) term.write(frame.data);
    if (frame.type === "exit") {
      entry.ended = true;
      term.write(`\r\n\x1b[2m[session ended, exit code ${frame.code}]\x1b[0m\r\n`);
      entry.onExit?.();
    }
  };
  socket.onclose = () => {
    setState(entry, "closed");
    if (!entry.mounted) entry.dispose();
  };
  const input = term.onData((data) => send({ type: "input", data }));

  kept.set(terminalId, entry);
  return entry;
}

/** Shows a kept terminal in host, opening it there the first time. */
function show(entry: Kept, host: HTMLElement): void {
  entry.mounted = true;
  entry.usedAt = Date.now();
  host.appendChild(entry.element);
  if (!entry.opened) {
    entry.opened = true;
    entry.term.open(entry.element);
    // Drawn on a fixed grid by the GPU, as a desktop terminal does, instead of as text the fonts can shift.
    // Without WebGL, or when the browser takes the context back, the DOM renderer carries on.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      entry.term.loadAddon(webgl);
    } catch {
      // No WebGL here: the DOM renderer stays.
    }
  }
  try {
    entry.fit.fit();
    entry.sendSize();
  } catch {
    // Measured again on the next resize.
  }
  // Taken off the page and put back, the browser resets the scrollbar to the top while xterm still
  // shows where it was, so the first wheel jumps up. One line there and back makes xterm set it again.
  requestAnimationFrame(() => {
    const term = entry.term;
    if (!entry.mounted || term.buffer.active.baseY === 0) return;
    const step = term.buffer.active.viewportY > 0 ? -1 : 1;
    term.scrollLines(step);
    term.scrollLines(-step);
  });
  entry.term.focus();
}

/** "a b" for a shell: a path with a space is quoted. */
const quoted = (path: string) => (/\s/.test(path) ? `"${path}"` : path);

/**
 * The session's own terminal, untouched: keystrokes go to the `claude`
 * process as they are, and its output is drawn as it comes. Leaving the view
 * only takes it off the page (see Kept); the process keeps running on the hub.
 */
export function TerminalView({ terminalId, onExit }: { terminalId: string; onExit?: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const entryRef = useRef<Kept | null>(null);
  const [state, setViewState] = useState<TerminalState>("connecting");
  const [finding, setFinding] = useState(false);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!host.current) return;
    const entry = keep(terminalId);
    entryRef.current = entry;
    const sync = () => setViewState(entry.state);
    entry.listeners.add(sync);
    sync();
    entry.onExit = onExit;
    entry.onFind = () => setFinding(true);
    show(entry, host.current);

    const observer = new ResizeObserver(() => {
      try {
        entry.fit.fit();
        entry.sendSize();
      } catch {
        // Hidden panels measure as zero; the next visible resize fixes it.
      }
    });
    observer.observe(host.current);

    return () => {
      observer.disconnect();
      entry.listeners.delete(sync);
      entry.onExit = undefined;
      entry.onFind = undefined;
      entry.mounted = false;
      entry.usedAt = Date.now();
      entry.element.remove();
      entryRef.current = null;
      prune();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId]);

  /** Files dropped from the computer are saved on the hub and their paths pasted, as a desktop terminal does. */
  const drop = async (event: React.DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const entry = entryRef.current;
    if (!entry) return;
    const files = [...event.dataTransfer.files];
    if (!files.length) {
      const text = event.dataTransfer.getData("text/plain");
      if (text) entry.term.paste(text);
      entry.term.focus();
      return;
    }
    try {
      const paths: string[] = [];
      for (const file of files) {
        const response = await fetch(`${projectApi()}/drop`, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(file.name) },
          body: file,
        });
        const payload = (await response.json().catch(() => ({}))) as { path?: string; error?: string };
        if (!response.ok || !payload.path) throw new Error(payload.error ?? `${response.status} ${response.statusText}`);
        paths.push(quoted(payload.path));
      }
      entry.term.paste(paths.join(" ") + " ");
      entry.term.focus();
    } catch (error) {
      useStore.getState().notify(`Could not drop the file: ${(error as Error).message}`, "error");
    }
  };

  return (
    <div
      className="relative h-full min-h-0 overflow-hidden rounded-lg border bg-[#141413]"
      onDragOver={(event) => {
        if (![...event.dataTransfer.types].some((type) => type === "Files" || type === "text/plain")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(event) => void drop(event)}
    >
      {/* A right click belongs to the terminal (Claude may take it as a mouse report), not the browser's menu; with text selected it copies it. */}
      <div
        ref={host}
        className="terminal-host h-full w-full"
        onContextMenu={(event) => {
          event.preventDefault();
          entryRef.current?.copy();
        }}
      />
      {finding && entryRef.current && (
        <FindBar
          search={entryRef.current.search}
          onClose={() => {
            entryRef.current?.search.clearDecorations();
            setFinding(false);
            entryRef.current?.term.focus();
          }}
        />
      )}
      {dragging && (
        <div className="pointer-events-none absolute inset-2 grid place-items-center rounded-lg border-2 border-dashed border-primary/70 bg-primary/10 text-xs text-foreground">
          Drop to paste its path
        </div>
      )}
      {state === "connecting" && <div className="absolute bottom-2 right-3 text-[11px] text-muted-foreground">connecting...</div>}
      {state === "closed" && <div className="absolute bottom-2 right-3 text-[11px] text-muted-foreground">detached</div>}
    </div>
  );
}

const FIND_DECORATIONS = {
  matchBackground: "#d7775755",
  matchOverviewRuler: "#d77757",
  activeMatchBackground: "#d77757",
  activeMatchColorOverviewRuler: "#f5f4ee",
};

/** Ctrl+F in a terminal: find in its scrollback. Enter goes to the next match, Shift+Enter the one before, Esc closes. */
function FindBar({ search, onClose }: { search: SearchAddon; onClose: () => void }) {
  const [text, setText] = useState("");
  const [result, setResult] = useState<{ index: number; count: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    const results = search.onDidChangeResults((value) => setResult({ index: value.resultIndex, count: value.resultCount }));
    return () => results.dispose();
  }, [search]);

  const find = (forward: boolean, value = text) => {
    if (!value) {
      search.clearDecorations();
      setResult(null);
      return;
    }
    const options = { decorations: FIND_DECORATIONS, incremental: false };
    if (forward) search.findNext(value, options);
    else search.findPrevious(value, options);
  };

  return (
    <div className="absolute right-3 top-2 z-10 flex items-center gap-1 rounded-md border bg-background/95 px-1.5 py-1 shadow-lg">
      <input
        ref={input}
        value={text}
        placeholder="Find"
        aria-label="Find in the terminal"
        onChange={(event) => {
          setText(event.target.value);
          find(true, event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          } else if (event.key === "Enter") {
            event.preventDefault();
            find(!event.shiftKey);
          }
        }}
        className="w-44 bg-transparent px-1 text-xs focus:outline-none"
      />
      <span className="min-w-[3.5rem] text-right text-[10px] tabular-nums text-muted-foreground">
        {text ? (result && result.count ? `${result.index + 1}/${result.count}` : "none") : ""}
      </span>
      <button onClick={() => find(false)} title="Previous (Shift+Enter)" aria-label="Previous match" className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground">
        <ChevronUp size={13} />
      </button>
      <button onClick={() => find(true)} title="Next (Enter)" aria-label="Next match" className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground">
        <ChevronDown size={13} />
      </button>
      <button onClick={onClose} title="Close (Esc)" aria-label="Close find" className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground">
        <X size={13} />
      </button>
    </div>
  );
}
