import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { describeCategories } from "./categories.js";
import { requireClaudeCode } from "./claudeCode.js";
import { claudeSettings, mcpSuggestionsEnabled, PERMISSION_MODES, settingFlags } from "./claudeSettings.js";
import { db, now, parseJson } from "./db.js";
import { broadcast } from "./events.js";
import { projectRoot, runDir } from "./paths.js";
import { renderPrompt } from "./prompts.js";
import { allTerminals, killTerminal, listTerminals, spawnTerminal, terminalForSession, waitForExit, type Terminal } from "./terminals.js";
import { defaultToolset, normaliseToolset, toolsetSettings, type Toolset } from "./toolset.js";
import { purposeSystemPrompt, purposeTitle, type Purpose } from "./purposes.js";
import { listTranscripts, type TranscriptSummary } from "./transcripts.js";

export type Origin = "manual" | "cron" | "webhook" | "queue";
export type SessionStatus = "running" | "waiting" | "done" | "exited" | "external";

export interface SessionRow {
  id: string;
  origin: Origin;
  run_id: string | null;
  category: string | null;
  status: "running" | "waiting" | "done" | "exited";
  done_json: string | null;
  done_attempts: number;
  toolset: string | null;
  purpose: string | null;
  setup: string | null;
  created_at: string;
  updated_at: string;
}

export function getSessionRow(id: string): SessionRow | null {
  return (db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined) ?? null;
}

export function setSessionStatus(id: string, status: SessionRow["status"], extra: { done_json?: string } = {}): void {
  db.prepare("UPDATE sessions SET status = ?, done_json = COALESCE(?, done_json), updated_at = ? WHERE id = ?").run(
    status,
    extra.done_json ?? null,
    now(),
    id,
  );
  broadcast("sessions", { sessionId: id });
}

export function bumpDoneAttempts(id: string): number {
  db.prepare("UPDATE sessions SET done_attempts = done_attempts + 1 WHERE id = ?").run(id);
  return getSessionRow(id)?.done_attempts ?? 0;
}

/** Claude Code may give a resumed session a new id; the hub's record follows it. */
export function renameSession(from: string, to: string): void {
  if (from === to) return;
  db.transaction(() => {
    if (!getSessionRow(to)) db.prepare("UPDATE sessions SET id = ? WHERE id = ?").run(to, from);
    db.prepare("UPDATE interactions SET session_id = ? WHERE session_id = ?").run(to, from);
    db.prepare("UPDATE runs SET session_id = ? WHERE session_id = ?").run(to, from);
    db.prepare("UPDATE channel_threads SET session_id = ? WHERE session_id = ?").run(to, from);
    db.prepare("UPDATE channel_refs SET session_id = ? WHERE session_id = ?").run(to, from);
    db.prepare("UPDATE mcp_suggestions SET session_id = ? WHERE session_id = ?").run(to, from);
  })();
  broadcast("sessions", {});
}

let hubPort = 0;
export function setHubPort(port: number): void {
  hubPort = port;
}
export function hubUrl(): string {
  return `http://127.0.0.1:${hubPort}`;
}
/** Where a person opens the dashboard: Vite's port under the dev launcher, the hub's own otherwise. */
export function dashboardUrl(): string {
  return `http://localhost:${process.env.CLAUDER_HUB_DEV && process.env.WEB_PORT ? process.env.WEB_PORT : hubPort}`;
}

/**
 * The hooks the hub listens on, passed with --settings for this process only:
 * nothing is written to the user's settings files, and the user's own hooks
 * still run. Each is an HTTP hook to localhost that the hub answers at once
 * with an empty object, so it never decides anything and never holds Claude up.
 * If the hub is gone the call fails, which Claude Code treats as non-blocking.
 */
function hookSettings(token: string): object {
  const url = `http://127.0.0.1:${hubPort}/api/hooks/${token}`;
  const hook = [{ hooks: [{ type: "http", url, timeout: 5 }] }];
  return {
    hooks: {
      SessionStart: hook,
      UserPromptSubmit: hook,
      PermissionRequest: hook,
      PreToolUse: [{ matcher: "AskUserQuestion", hooks: [{ type: "http", url, timeout: 5 }] }],
      Notification: hook,
      Stop: hook,
      SessionEnd: hook,
    },
  };
}

/** The text appended to Claude Code's own system prompt for one session. */
export function systemPromptFor(category: string | null, purpose: Purpose | null = null, setup: SessionSetup | null = null): string {
  const parts = [renderPrompt("system.base", { project: projectRoot() })];
  if (mcpSuggestionsEnabled()) parts.push(renderPrompt("system.mcp", {}));
  if (category) parts.push(renderPrompt("system.done", { category, categories: describeCategories() }));
  if (purpose) parts.push(purposeSystemPrompt(purpose, hubUrl()));
  if (setup && (setup.notes || setup.variables.length)) {
    parts.push(
      renderPrompt("system.setup", {
        notes: setup.notes || "(no notes)",
        variables: setup.variables.length ? setup.variables.map((item) => `- ${item.name}: ${item.value}`).join("\n") : "(none)",
      }),
    );
  }
  return parts.join("\n\n");
}

/** What the person set up for one session in its Setup tab; it goes into the system prompt. */
export interface SessionSetup {
  notes: string;
  variables: Array<{ name: string; value: string }>;
}

export function normaliseSetup(input: unknown): SessionSetup {
  const value = (input ?? {}) as { notes?: unknown; variables?: unknown };
  const variables = (Array.isArray(value.variables) ? value.variables : [])
    .map((item) => ({ name: String(item?.name ?? "").trim(), value: String(item?.value ?? "").trim() }))
    .filter((item) => item.name);
  // One line each in the prompt, so a value cannot open a section of its own.
  for (const item of variables) if (/[\r\n]/.test(item.name + item.value)) throw new Error(`'${item.name}' must fit on one line.`);
  return { notes: String(value.notes ?? "").trim(), variables };
}

export function sessionSetup(sessionId: string): SessionSetup {
  return normaliseSetup(parseJson(getSessionRow(sessionId)?.setup, {}));
}

/** Saves a session's setup; it reaches Claude at the next start, so the caller restarts a live session. */
export function setSessionSetup(sessionId: string, setup: SessionSetup): void {
  const stamp = now();
  db.prepare(
    `INSERT INTO sessions (id, origin, setup, status, created_at, updated_at) VALUES (?, 'manual', ?, 'exited', ?, ?)
     ON CONFLICT(id) DO UPDATE SET setup = excluded.setup, updated_at = excluded.updated_at`,
  ).run(sessionId, JSON.stringify(setup), stamp, stamp);
  broadcast("sessions", { sessionId });
}

export interface StartOptions {
  prompt?: string;
  /** Resume this session instead of starting a new one. */
  resumeId?: string;
  origin?: Origin;
  runId?: string;
  /** '' or null for none, 'auto', or a category name. A category turns on the done protocol. */
  category?: string | null;
  name?: string;
  /** Omitted: the hub's Claude settings, else whatever the user's settings say. */
  permissionMode?: string;
  /** A configuration session's one purpose; kept for its resumes. */
  purpose?: Purpose;
  /** What is turned off. Omitted: what the session had last time, else the default preset. */
  toolset?: Toolset;
  cols?: number;
  rows?: number;
}

export function startSession(options: StartOptions): Terminal {
  const claude = requireClaudeCode();
  if (options.resumeId) {
    const running = terminalForSession(options.resumeId);
    if (running) return running;
  }

  const existing = options.resumeId ? getSessionRow(options.resumeId) : null;
  const sessionId = options.resumeId ?? randomUUID();
  const category = options.category !== undefined ? options.category || null : (existing?.category ?? null);
  const token = nanoid(24);
  const toolset = options.toolset ? normaliseToolset(options.toolset) : existing?.toolset ? normaliseToolset(JSON.parse(existing.toolset)) : defaultToolset();

  const settingsFile = path.join(runDir, `${token}.settings.json`);
  const promptFile = path.join(runDir, `${token}.prompt.md`);
  // Hooks and toolset share one --settings file; their keys never overlap.
  fs.writeFileSync(settingsFile, JSON.stringify({ ...toolsetSettings(toolset), ...hookSettings(token) }, null, 2), "utf8");
  const purpose = options.purpose ?? (existing?.purpose ? (JSON.parse(existing.purpose) as Purpose) : null);
  fs.writeFileSync(promptFile, systemPromptFor(category, purpose, existing ? sessionSetup(sessionId) : null), "utf8");

  const args = ["--settings", settingsFile, "--append-system-prompt-file", promptFile];
  args.push(...(options.resumeId ? ["--resume", options.resumeId] : ["--session-id", sessionId]));
  if (options.name) args.push("--name", options.name);
  const settings = claudeSettings();
  // A run keeps the unattended mode when it is resumed or restarted (an MCP added, its toolset or setup changed).
  const origin = existing?.origin ?? options.origin ?? "manual";
  const unattended = Boolean(options.runId ?? existing?.run_id) || origin === "cron" || origin === "webhook" || origin === "queue";
  const permissionMode = options.permissionMode ?? (unattended ? settings.runPermissionMode : settings.permissionMode);
  if (permissionMode) {
    if (!PERMISSION_MODES.includes(permissionMode)) throw new Error(`Unknown permission mode '${permissionMode}'.`);
    args.push("--permission-mode", permissionMode);
  }
  args.push(...settingFlags(settings));
  if (options.prompt?.trim()) {
    // Options end here: --add-dir takes any number of paths and would take the prompt as one, and a prompt may start with a dash.
    args.push("--", options.prompt.trim());
  }

  const stamp = now();
  db.prepare(
    `INSERT INTO sessions (id, origin, run_id, category, toolset, purpose, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)
     ON CONFLICT(id) DO UPDATE SET status = 'running', category = excluded.category, toolset = excluded.toolset, purpose = excluded.purpose,
       run_id = COALESCE(excluded.run_id, sessions.run_id), updated_at = excluded.updated_at`,
  ).run(sessionId, existing?.origin ?? options.origin ?? "manual", options.runId ?? null, category, JSON.stringify(toolset), purpose ? JSON.stringify(purpose) : null, stamp, stamp);

  return spawnTerminal({ file: claude, args, sessionId, token, cols: options.cols, rows: options.rows });
}

/**
 * Stops a live session and starts it again on the same conversation, for
 * changes Claude Code only reads at start-up (an MCP server, a toolset). Its
 * exit is marked as a restart, so it does not end the session's queued run.
 */
export async function restartSession(sessionId: string, options: Pick<StartOptions, "prompt" | "toolset"> = {}): Promise<Terminal> {
  const terminal = terminalForSession(sessionId);
  if (terminal) {
    terminal.restarting = true;
    killTerminal(terminal);
    await waitForExit(terminal);
  }
  return startSession({ resumeId: sessionId, ...options, cols: terminal?.cols, rows: terminal?.rows });
}

/** The toolset a session has, or will start with on its next resume. */
export function sessionToolset(sessionId: string): Toolset {
  const row = getSessionRow(sessionId);
  return row?.toolset ? normaliseToolset(JSON.parse(row.toolset)) : defaultToolset();
}

/** Saves a toolset for a session that is not running; it applies when it is resumed. */
export function setSessionToolset(sessionId: string, toolset: Toolset): void {
  const stamp = now();
  db.prepare(
    `INSERT INTO sessions (id, origin, toolset, status, created_at, updated_at) VALUES (?, 'manual', ?, 'exited', ?, ?)
     ON CONFLICT(id) DO UPDATE SET toolset = excluded.toolset, updated_at = excluded.updated_at`,
  ).run(sessionId, JSON.stringify(normaliseToolset(toolset)), stamp, stamp);
  broadcast("sessions", { sessionId });
}

export function terminalByToken(token: string): Terminal | undefined {
  return allTerminals().find((terminal) => terminal.token === token);
}

/** The run folder holds one settings and one prompt file per terminal; they are only needed while it lives. */
export function cleanRunFiles(token: string): void {
  for (const suffix of [".settings.json", ".prompt.md"]) fs.rmSync(path.join(runDir, `${token}${suffix}`), { force: true });
}

export interface SessionView extends Partial<TranscriptSummary> {
  id: string;
  title: string;
  origin: Origin | "external";
  status: SessionStatus;
  live: boolean;
  terminalId: string | null;
  category: string | null;
  runId: string | null;
  openInteractions: number;
  done: unknown;
  /** Set on a configuration session: what it is for. */
  purpose: (Purpose & { title: string }) | null;
}

function purposeOf(row: SessionRow | undefined): SessionView["purpose"] {
  const purpose = parseJson<Purpose | null>(row?.purpose, null);
  return purpose ? { ...purpose, title: purposeTitle(purpose) } : null;
}

export function listSessions(): SessionView[] {
  const rows = new Map((db.prepare("SELECT * FROM sessions").all() as SessionRow[]).map((row) => [row.id, row]));
  const open = new Map(
    (db.prepare("SELECT session_id, COUNT(*) AS n FROM interactions WHERE status = 'open' GROUP BY session_id").all() as Array<{ session_id: string; n: number }>).map(
      (row) => [row.session_id, row.n],
    ),
  );
  const terminals = new Map(listTerminals().map((terminal) => [terminal.sessionId, terminal]));
  const views: SessionView[] = [];
  const seen = new Set<string>();

  const view = (id: string, summary: Partial<TranscriptSummary> | null): SessionView => {
    const row = rows.get(id);
    const terminal = terminals.get(id);
    const status: SessionStatus = terminal
      ? row?.status === "waiting"
        ? "waiting"
        : "running"
      : row
        ? row.status === "done"
          ? "done"
          : "exited"
        : "external";
    const purpose = purposeOf(row);
    return {
      ...(summary ?? {}),
      id,
      // A hub task opens at the prompt with no first message, so it has no transcript title yet: its purpose names it.
      title: summary?.title ?? (purpose ? `Hub: ${purpose.title}` : "Starting..."),
      origin: row?.origin ?? "external",
      status,
      live: Boolean(terminal),
      terminalId: terminal?.id ?? null,
      category: row?.category ?? null,
      runId: row?.run_id ?? null,
      openInteractions: open.get(id) ?? 0,
      done: parseJson(row?.done_json, null),
      purpose,
    };
  };

  for (const summary of listTranscripts()) {
    seen.add(summary.id);
    views.push(view(summary.id, summary));
  }
  // Started a moment ago: the terminal is up but Claude has not written a line yet.
  for (const terminal of terminals.values()) {
    if (!seen.has(terminal.sessionId)) views.unshift(view(terminal.sessionId, { startedAt: terminal.startedAt, lastAt: terminal.startedAt }));
  }
  return views;
}
