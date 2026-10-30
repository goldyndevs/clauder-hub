import * as pty from "@lydell/node-pty";
import { nanoid } from "nanoid";
import type { WebSocket } from "ws";
import { bindProject, currentProject } from "./context.js";
import { broadcast } from "./events.js";
import { projectRoot } from "./paths.js";

/**
 * A terminal is a real `claude` process in a pseudo-terminal. The dashboard
 * shows it with xterm.js and adds nothing to it: what you see and type is the
 * Claude Code TUI itself. It outlives the browser tab; closing the page only
 * detaches, the way tmux does, and reopening replays what was missed.
 */
export interface Terminal {
  id: string;
  /** The Claude Code session it runs. Learned from the SessionStart hook if it changes on resume. */
  sessionId: string;
  /** Authenticates this terminal's hook calls. */
  token: string;
  /** The project it runs in; its hooks and its exit are handled there. */
  projectId: string;
  pty: pty.IPty;
  startedAt: string;
  clients: Set<WebSocket>;
  /** Recent output, replayed to a client that attaches later. */
  backlog: string[];
  backlogSize: number;
  cols: number;
  rows: number;
  /** Stopped on purpose to be resumed at once (an MCP was installed), so its exit ends nothing. */
  restarting?: boolean;
  /** Closed by the hub because the task is done. */
  finished?: boolean;
}

const BACKLOG_LIMIT = 2 * 1024 * 1024;
const terminals = new Map<string, Terminal>();
const exitListeners = new Set<(terminal: Terminal, exitCode: number) => void>();

export function onTerminalExit(listener: (terminal: Terminal, exitCode: number) => void): void {
  exitListeners.add(listener);
}

/**
 * Markers a parent Claude Code session leaves in its children's environment.
 * A hub started from inside a session would hand them on, and the sessions it
 * starts would then think they are subagents (and, for one, stop saving their
 * transcript).
 */
const INHERITED_MARKERS = [
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "AI_AGENT",
];

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !INHERITED_MARKERS.includes(key)) env[key] = value;
  }
  return { ...env, CLAUDER_HUB: "1", FORCE_COLOR: "1" };
}

export function spawnTerminal(input: { file: string; args: string[]; sessionId: string; token?: string; cols?: number; rows?: number }): Terminal {
  const cols = input.cols ?? 120;
  const rows = input.rows ?? 32;
  const child = pty.spawn(input.file, input.args, {
    name: "xterm-256color",
    cols,
    rows,
    cwd: projectRoot(),
    env: childEnv(),
  });
  const terminal: Terminal = {
    id: nanoid(10),
    sessionId: input.sessionId,
    token: input.token ?? nanoid(24),
    projectId: currentProject().id,
    pty: child,
    startedAt: new Date().toISOString(),
    clients: new Set(),
    backlog: [],
    backlogSize: 0,
    cols,
    rows,
  };
  terminals.set(terminal.id, terminal);

  // The pty calls back from native code: each handler is put back in this terminal's project.
  child.onData(bindProject((data: string) => {
    terminal.backlog.push(data);
    terminal.backlogSize += data.length;
    while (terminal.backlogSize > BACKLOG_LIMIT && terminal.backlog.length > 1) {
      terminal.backlogSize -= terminal.backlog.shift()!.length;
    }
    const frame = JSON.stringify({ type: "output", data });
    for (const client of terminal.clients) if (client.readyState === client.OPEN) client.send(frame);
  }));

  child.onExit(bindProject(({ exitCode }: { exitCode: number }) => {
    terminals.delete(terminal.id);
    const frame = JSON.stringify({ type: "exit", code: exitCode });
    for (const client of terminal.clients) {
      if (client.readyState === client.OPEN) client.send(frame);
      client.close();
    }
    for (const listener of exitListeners) {
      try {
        listener(terminal, exitCode);
      } catch (error) {
        console.error("[terminal] exit listener failed:", error);
      }
    }
    broadcast("sessions", {});
  }));

  broadcast("sessions", {});
  return terminal;
}

export function getTerminal(id: string): Terminal | undefined {
  return terminals.get(id);
}

/** The current project's terminal running that session. */
export function terminalForSession(sessionId: string): Terminal | undefined {
  const projectId = currentProject().id;
  for (const terminal of terminals.values()) if (terminal.sessionId === sessionId && terminal.projectId === projectId) return terminal;
  return undefined;
}

/** The current project's terminals. */
export function listTerminals(): Terminal[] {
  const projectId = currentProject().id;
  return [...terminals.values()].filter((terminal) => terminal.projectId === projectId);
}

/** Every project's, for finding a hook's terminal by its token. */
export function allTerminals(): Terminal[] {
  return [...terminals.values()];
}

export function attachClient(terminal: Terminal, socket: WebSocket): void {
  terminal.clients.add(socket);
  if (terminal.backlog.length) socket.send(JSON.stringify({ type: "output", data: terminal.backlog.join("") }));
  socket.on("message", (raw) => {
    let message: any;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (message?.type === "input" && typeof message.data === "string") terminal.pty.write(message.data);
    else if (message?.type === "resize") resizeTerminal(terminal, Number(message.cols), Number(message.rows));
  });
  socket.on("close", () => terminal.clients.delete(socket));
}

function resizeTerminal(terminal: Terminal, cols: number, rows: number): void {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 10 || rows < 4) return;
  if (cols === terminal.cols && rows === terminal.rows) return;
  terminal.cols = cols;
  terminal.rows = rows;
  try {
    terminal.pty.resize(cols, rows);
  } catch {
    // The process is on its way out.
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Raw keys, for answering a dialog: "1", "\x1b", "\r". */
export async function pressKeys(terminal: Terminal, ...keys: string[]): Promise<void> {
  for (const key of keys) {
    terminal.pty.write(key);
    await sleep(120);
  }
}

/**
 * Types a message into Claude Code's prompt and submits it, as if typed. A
 * multi-line message goes in as a bracketed paste, so its newlines stay
 * newlines instead of each one submitting.
 */
export async function typeMessage(terminal: Terminal, text: string): Promise<void> {
  const body = text.replace(/\r\n/g, "\n");
  terminal.pty.write(body.includes("\n") ? `\x1b[200~${body}\x1b[201~` : body);
  await sleep(250);
  terminal.pty.write("\r");
}

export function killTerminal(terminal: Terminal): void {
  try {
    terminal.pty.kill();
  } catch {
    // Already gone.
  }
}

export function waitForExit(terminal: Terminal, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      if (!terminals.has(terminal.id) || Date.now() - started > timeoutMs) return resolve();
      setTimeout(check, 100);
    };
    check();
  });
}

export function killAll(): void {
  for (const terminal of terminals.values()) killTerminal(terminal);
}

/** A project removed from the hub takes its sessions with it; returns them, to wait for their exits. */
export function killProjectTerminals(projectId: string): Terminal[] {
  const killed = [...terminals.values()].filter((terminal) => terminal.projectId === projectId);
  for (const terminal of killed) killTerminal(terminal);
  return killed;
}
