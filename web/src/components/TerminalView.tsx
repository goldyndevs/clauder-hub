import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { filesApi } from "../lib/filesApi";
import { openedFromTerminal, useOpenFiles } from "../lib/openFiles";
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

/**
 * The session's own terminal, untouched: keystrokes go to the `claude`
 * process as they are, and its output is drawn as it comes. Leaving the page
 * only detaches; the process keeps running on the hub and the next attach
 * replays what it printed meanwhile.
 */
export function TerminalView({ terminalId, onExit }: { terminalId: string; onExit?: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"connecting" | "open" | "closed">("connecting");

  useEffect(() => {
    if (!host.current) return;
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
    term.open(host.current);
    // Drawn on a fixed grid by the GPU, as a desktop terminal does, instead of as text the fonts can shift.
    // Without WebGL, or when the browser takes the context back, the DOM renderer carries on.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      // No WebGL here: the DOM renderer stays.
    }
    fit.fit();
    // xterm turns Ctrl+V into ^V and cancels the key, so the browser never pastes. Let the browser
    // have it: its paste event reaches xterm, which sends the text (bracketed when Claude asks for it).
    term.attachCustomKeyEventHandler((event) => !(event.type === "keydown" && event.ctrlKey && !event.altKey && !event.metaKey && event.code === "KeyV"));

    const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/terminals/${terminalId}`);
    const send = (message: unknown) => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify(message));
    const sendSize = () => send({ type: "resize", cols: term.cols, rows: term.rows });

    socket.onopen = () => {
      setState("open");
      sendSize();
      term.focus();
    };
    socket.onmessage = (event) => {
      const frame = JSON.parse(event.data) as { type: string; data?: string; code?: number };
      if (frame.type === "output" && frame.data) term.write(frame.data);
      if (frame.type === "exit") {
        term.write(`\r\n\x1b[2m[session ended, exit code ${frame.code}]\x1b[0m\r\n`);
        onExit?.();
      }
    };
    socket.onclose = () => setState("closed");

    const input = term.onData((data) => send({ type: "input", data }));
    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
        sendSize();
      } catch {
        // Hidden panels measure as zero; the next visible resize fixes it.
      }
    });
    observer.observe(host.current);

    return () => {
      observer.disconnect();
      pathLinks.dispose();
      input.dispose();
      socket.close();
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId]);

  return (
    <div className="relative h-full min-h-0 overflow-hidden rounded-lg border bg-[#141413]">
      {/* A right click belongs to the terminal (Claude may take it as a mouse report), not the browser's menu. */}
      <div ref={host} className="terminal-host h-full w-full" onContextMenu={(event) => event.preventDefault()} />
      {state === "connecting" && <div className="absolute bottom-2 right-3 text-[11px] text-muted-foreground">connecting...</div>}
      {state === "closed" && <div className="absolute bottom-2 right-3 text-[11px] text-muted-foreground">detached</div>}
    </div>
  );
}
