import { exec } from "node:child_process";
import { nanoid } from "nanoid";
import { db, now } from "./db.js";
import { broadcast } from "./events.js";
import { closeOpen, createInteraction } from "./interactions.js";
import { projectRoot } from "./paths.js";
import { renderPrompt } from "./prompts.js";
import { restartSession } from "./sessions.js";
import { terminalForSession, typeMessage } from "./terminals.js";

/**
 * A session that is blocked on a missing integration says so in a block the
 * hub reads from its last message (see the system.base prompt). The hub keeps
 * the suggestion, asks a person, and only on their word runs the install
 * command, always at project scope, then resumes the session so it loads.
 */
export interface Suggestion {
  id: string;
  sessionId: string;
  name: string;
  reason: string;
  command: string;
  docs: string | null;
  status: "suggested" | "installed" | "failed" | "dismissed";
  output: string | null;
  /** The command exactly as the hub would run it, or why it will not. */
  runs: string | null;
  refused: string | null;
  createdAt: string;
  updatedAt: string;
}

function preview(command: string): { runs: string | null; refused: string | null } {
  try {
    return { runs: normaliseCommand(command), refused: null };
  } catch (error) {
    return { runs: null, refused: (error as Error).message };
  }
}

interface Row {
  id: string;
  session_id: string;
  name: string;
  reason: string;
  command: string;
  docs: string | null;
  status: Suggestion["status"];
  output: string | null;
  created_at: string;
  updated_at: string;
}

const toSuggestion = (row: Row): Suggestion => ({
  id: row.id,
  sessionId: row.session_id,
  name: row.name,
  reason: row.reason,
  command: row.command,
  docs: row.docs,
  status: row.status,
  output: row.output,
  ...preview(row.command),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export function listSuggestions(): Suggestion[] {
  return (db.prepare("SELECT * FROM mcp_suggestions ORDER BY created_at DESC").all() as Row[]).map(toSuggestion);
}

function getSuggestion(id: string): Suggestion | null {
  const row = db.prepare("SELECT * FROM mcp_suggestions WHERE id = ?").get(id) as Row | undefined;
  return row ? toSuggestion(row) : null;
}

/**
 * Only `claude mcp add` is ever run, and always at project scope, whatever
 * scope the suggestion named. Anything else is refused rather than executed.
 */
export function normaliseCommand(command: string, scope: "project" | "local" = "project"): string {
  const trimmed = command.trim().replace(/\s+/g, " ");
  if (!/^claude mcp add(-json)? /.test(trimmed)) throw new Error("Only a 'claude mcp add ...' command can be run from the hub.");
  if (/[;&|`<>\n]|\$\(/.test(trimmed)) throw new Error("The command has shell operators in it; run it yourself if it is what you want.");
  const withoutScope = trimmed.replace(/ (-s|--scope)(=| )\S+/g, "");
  return withoutScope.replace(/^claude mcp add(-json)? /, (head) => `${head}--scope ${scope} `);
}

/**
 * Adds an MCP server from the catalog (or any `claude mcp add` a hub task
 * settled on with the person). Project scope writes the project's .mcp.json;
 * local scope keeps it in ~/.claude.json for this project only, which is where
 * a server with a token belongs, out of the repository. New sessions load it.
 */
export async function installServer(command: unknown, scope: unknown): Promise<{ ok: boolean; command: string; output: string }> {
  if (typeof command !== "string") throw new Error("Send { command, scope }.");
  const settled = normaliseCommand(command, scope === "local" ? "local" : "project");
  const result = await run(settled);
  broadcast("mcp", {});
  return { ok: result.ok, command: settled, output: result.output };
}

export function createSuggestion(sessionId: string, input: { name?: unknown; reason?: unknown; command?: unknown; docs?: unknown }): Suggestion | null {
  const name = String(input.name ?? "").trim();
  const command = String(input.command ?? "").trim();
  if (!name || !command) return null;
  // One open suggestion per server name; a second session asking for it adds nothing new.
  const existing = db.prepare("SELECT * FROM mcp_suggestions WHERE name = ? AND status = 'suggested'").get(name) as Row | undefined;
  const id = existing?.id ?? nanoid(10);
  if (!existing) {
    db.prepare(
      "INSERT INTO mcp_suggestions (id, session_id, name, reason, command, docs, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'suggested', ?, ?)",
    ).run(id, sessionId, name, String(input.reason ?? "").trim(), command, input.docs ? String(input.docs) : null, now(), now());
  }
  broadcast("mcp", {});
  const suggestion = getSuggestion(id)!;
  let shown = command;
  try {
    shown = normaliseCommand(command);
  } catch {
    // Shown as Claude wrote it; installing it will be refused with the reason.
  }
  createInteraction({
    sessionId,
    kind: "mcp",
    title: `Install MCP '${name}'?`,
    body: suggestion.reason,
    options: [
      { key: "install", label: "Install and resume" },
      { key: "skip", label: "Skip, carry on without it" },
    ],
    data: { suggestionId: id, name, reason: suggestion.reason, command: shown, docs: suggestion.docs },
  });
  return suggestion;
}

function run(command: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    exec(command, { cwd: projectRoot(), timeout: 120_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, output: `${stdout}${stderr}${error && !stderr ? error.message : ""}`.trim() });
    });
  });
}

export async function installSuggestion(id: string, by: string): Promise<Suggestion> {
  const suggestion = getSuggestion(id);
  if (!suggestion) throw new Error("No such suggestion.");
  if (suggestion.status === "installed") throw new Error("Already installed.");
  const command = normaliseCommand(suggestion.command);
  const result = await run(command);
  db.prepare("UPDATE mcp_suggestions SET status = ?, output = ?, command = ?, updated_at = ? WHERE id = ?").run(
    result.ok ? "installed" : "failed",
    `$ ${command}\n${result.output}`,
    command,
    now(),
    id,
  );
  broadcast("mcp", {});
  closeOpen(suggestion.sessionId, by, ["mcp"]);

  const terminal = terminalForSession(suggestion.sessionId);
  if (!result.ok) {
    if (terminal) await typeMessage(terminal, `Clauder Hub: installing the MCP server '${suggestion.name}' failed:\n${result.output.slice(0, 800)}\nCarry on without it if you can, or say what is needed.`);
    return getSuggestion(id)!;
  }

  // MCP servers load at start-up, so the session is restarted onto the same conversation.
  await restartSession(suggestion.sessionId, { prompt: renderPrompt("typed.mcpInstalled", { name: suggestion.name }) });
  return getSuggestion(id)!;
}

export async function skipSuggestion(id: string, note: string): Promise<Suggestion> {
  const suggestion = getSuggestion(id);
  if (!suggestion) throw new Error("No such suggestion.");
  db.prepare("UPDATE mcp_suggestions SET status = 'dismissed', updated_at = ? WHERE id = ?").run(now(), id);
  broadcast("mcp", {});
  closeOpen(suggestion.sessionId, "dashboard", ["mcp"]);
  const terminal = terminalForSession(suggestion.sessionId);
  if (terminal) await typeMessage(terminal, renderPrompt("typed.mcpSkipped", { name: suggestion.name, note }));
  return getSuggestion(id)!;
}

export function deleteSuggestion(id: string): void {
  db.prepare("DELETE FROM mcp_suggestions WHERE id = ?").run(id);
  broadcast("mcp", {});
}
