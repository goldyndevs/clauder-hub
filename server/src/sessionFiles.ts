import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db } from "./db.js";
import { broadcast } from "./events.js";
import { claudeHome, projectRoot, projectSlug, transcriptsDir } from "./paths.js";
import { killTerminal, terminalForSession, waitForExit } from "./terminals.js";
import { forgetTranscript } from "./transcripts.js";

/**
 * Renaming and deleting a session, in Claude Code's own files. A session id
 * becomes a path here, so only a well-formed id is ever accepted.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function checkId(id: string): void {
  if (!UUID.test(id)) throw new Error("Not a session id.");
}

function transcriptFile(id: string): string {
  return path.join(transcriptsDir(), `${id}.jsonl`);
}

/**
 * The same record /rename and --name write, appended to the transcript, so
 * Claude Code's /resume shows the new name too. A live session gets it as
 * well; its terminal's own title catches up on its next start.
 */
export function setSessionTitle(id: string, title: string): void {
  checkId(id);
  const name = title.replace(/\s+/g, " ").trim();
  if (!name) throw new Error("The name is empty.");
  if (name.length > 200) throw new Error("Keep the name under 200 characters.");
  const file = transcriptFile(id);
  if (!fs.existsSync(file)) throw new Error("This session has no transcript yet; give it a moment to start.");
  // A line still being written must not get our record glued onto it.
  const size = fs.statSync(file).size;
  let lead = "";
  if (size > 0) {
    const fd = fs.openSync(file, "r");
    const last = Buffer.alloc(1);
    fs.readSync(fd, last, 0, 1, size - 1);
    fs.closeSync(fd);
    if (last.toString() !== "\n") lead = "\n";
  }
  fs.appendFileSync(file, `${lead}${JSON.stringify({ type: "custom-title", customTitle: name, sessionId: id })}\n`, "utf8");
  broadcast("sessions", { sessionId: id });
}

function sizeOf(target: string): number {
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) return stat.size;
  return fs.readdirSync(target).reduce((total, name) => total + sizeOf(path.join(target, name)), 0);
}

export interface DeletionPlan {
  sessionId: string;
  files: Array<{ path: string; bytes: number; what: string }>;
  totalBytes: number;
  /** The session's scratch folder under the system temp directory, if it has one; removed only when asked. */
  temp: { path: string; bytes: number } | null;
}

/**
 * Claude Code gives each session a scratch folder under the system temp
 * directory: <temp>/claude/<project slug>/<session id> on Windows, and a
 * per-user "claude-<uid>" folder is also looked for, since a shared /tmp on
 * Linux keeps users apart that way. The first that exists is the one.
 */
function tempDirOf(id: string): string {
  const base = process.env.CLAUDE_CODE_TMPDIR ?? os.tmpdir();
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const roots = [path.join(base, "claude"), ...(uid !== null ? [path.join(base, `claude-${uid}`)] : [])];
  const candidates = roots.map((root) => path.join(root, projectSlug(projectRoot()), id));
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

/**
 * Everything of a session's that Claude Code keeps per session. Not
 * ~/.claude/history.jsonl: that is the prompt history every project shares,
 * and other sessions write to it while this runs.
 */
export function deletionPlan(id: string): DeletionPlan {
  checkId(id);
  const candidates: Array<[string, string]> = [
    [transcriptFile(id), "transcript"],
    [path.join(transcriptsDir(), id), "subagent transcripts and tool output"],
    [path.join(claudeHome, "file-history", id), "file snapshots used to rewind"],
    [path.join(claudeHome, "session-env", id), "session environment"],
  ];
  const files = candidates.filter(([target]) => fs.existsSync(target)).map(([target, what]) => ({ path: target, bytes: sizeOf(target), what }));
  const temp = tempDirOf(id);
  return {
    sessionId: id,
    files,
    totalBytes: files.reduce((total, item) => total + item.bytes, 0),
    temp: fs.existsSync(temp) ? { path: temp, bytes: sizeOf(temp) } : null,
  };
}

/** A running session is stopped first: its process holds the transcript open and would write to it again. */
export async function deleteSession(id: string, options: { clearTemp?: boolean } = {}): Promise<DeletionPlan> {
  checkId(id);
  const terminal = terminalForSession(id);
  if (terminal) {
    killTerminal(terminal);
    await waitForExit(terminal);
    if (terminalForSession(id)) throw new Error("The session did not stop in time; nothing was deleted. Try again.");
  }
  const plan = deletionPlan(id);
  for (const item of plan.files) fs.rmSync(item.path, { recursive: true, force: true });
  if (options.clearTemp !== false && plan.temp) fs.rmSync(plan.temp.path, { recursive: true, force: true });
  db.transaction(() => {
    for (const table of ["interactions", "mcp_suggestions", "channel_refs", "channel_threads", "sessions"]) {
      db.prepare(`DELETE FROM ${table} WHERE ${table === "sessions" ? "id" : "session_id"} = ?`).run(id);
    }
  })();
  forgetTranscript(id);
  broadcast("sessions", {});
  broadcast("interactions", {});
  broadcast("mcp", {});
  return plan;
}
