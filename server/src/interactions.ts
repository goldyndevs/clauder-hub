import { bindProject } from "./context.js";
import { nanoid } from "nanoid";
import { db, now, parseJson } from "./db.js";
import { broadcast } from "./events.js";
import { notifyChannels, acknowledgeOnChannels } from "./channels/index.js";
import { present, resolveChoice, type Presented } from "./presentation.js";
import { listSessions, setSessionStatus } from "./sessions.js";
import { pressKeys, terminalForSession, typeMessage } from "./terminals.js";
import { lastToolResultAt, transcriptMtime } from "./transcripts.js";

/**
 * Anything a session waits on a person for: a permission dialog, a question,
 * the end of a turn, a suggested MCP server. Each one goes to every channel at
 * once, and the first answer wins, whether it came from a channel, the
 * dashboard, or the terminal itself.
 *
 * An answer from outside the terminal is delivered by typing into it, so the
 * session sees exactly what it would have seen from a person at the keyboard.
 */
export type InteractionKind = "permission" | "question" | "turn" | "mcp" | "done";

export interface Option {
  key: string;
  label: string;
}

export interface Interaction {
  id: string;
  sessionId: string;
  kind: InteractionKind;
  title: string;
  body: string;
  options: Option[];
  data: Record<string, any>;
  status: "open" | "answered" | "closed";
  answeredBy: string | null;
  answer: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  session_id: string;
  kind: InteractionKind;
  title: string;
  body: string;
  options: string;
  data: string;
  status: Interaction["status"];
  answered_by: string | null;
  answer: string | null;
  created_at: string;
  updated_at: string;
}

const toInteraction = (row: Row): Interaction => ({
  id: row.id,
  sessionId: row.session_id,
  kind: row.kind,
  title: row.title,
  body: row.body,
  options: parseJson<Option[]>(row.options, []),
  data: parseJson<Record<string, any>>(row.data, {}),
  status: row.status,
  answeredBy: row.answered_by,
  answer: row.answer,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export function getInteraction(id: string): Interaction | null {
  const row = db.prepare("SELECT * FROM interactions WHERE id = ?").get(id) as Row | undefined;
  return row ? toInteraction(row) : null;
}

export function listInteractions(filter: { sessionId?: string; status?: string; limit?: number } = {}): Interaction[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.sessionId) {
    where.push("session_id = ?");
    params.push(filter.sessionId);
  }
  if (filter.status) {
    where.push("status = ?");
    params.push(filter.status);
  }
  const sql = `SELECT * FROM interactions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`;
  return (db.prepare(sql).all(...params, filter.limit ?? 200) as Row[]).map(toInteraction);
}

/** Interactions with what a person should see of them, titles looked up once for the lot. */
export function withPresentation(items: Interaction[]): Array<Interaction & { presented: Presented }> {
  const titles = new Map(listSessions().map((session) => [session.id, session.title]));
  return items.map((item) => {
    const title = titles.get(item.sessionId);
    return { ...item, presented: present(item, title && title !== "Starting..." ? title : `session ${item.sessionId.slice(0, 8)}`) };
  });
}

/** A button press: the hub turns the button back into the answer it stands for. */
export async function chooseInteraction(id: string, ref: string, by: string): Promise<Interaction> {
  const interaction = getInteraction(id);
  if (!interaction) throw new AnswerError("No such interaction.");
  const answer = resolveChoice(interaction, ref);
  if (!answer) throw new AnswerError("That button no longer means anything here.");
  return answerInteraction(id, answer, by);
}

export function sessionTitle(sessionId: string): string {
  const session = listSessions().find((item) => item.id === sessionId);
  return session && session.title !== "Starting..." ? session.title : `session ${sessionId.slice(0, 8)}`;
}

/** A new interaction replaces whatever was still open on that session: the session has moved on. */
export function createInteraction(input: {
  sessionId: string;
  kind: InteractionKind;
  title: string;
  body: string;
  options?: Option[];
  data?: Record<string, unknown>;
  /** Informational only (done): goes out to channels but waits on nobody. */
  closed?: boolean;
}): Interaction {
  closeOpen(input.sessionId, "superseded");
  const id = nanoid(12);
  const stamp = now();
  const data = { ...(input.data ?? {}), transcriptMtime: transcriptMtime(input.sessionId) };
  db.prepare(
    `INSERT INTO interactions (id, session_id, kind, title, body, options, data, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.sessionId, input.kind, input.title, input.body, JSON.stringify(input.options ?? []), JSON.stringify(data), input.closed ? "closed" : "open", stamp, stamp);
  if (!input.closed) setSessionStatus(input.sessionId, "waiting");
  const interaction = getInteraction(id)!;
  broadcast("interactions", { sessionId: input.sessionId });
  void notifyChannels(interaction, sessionTitle(input.sessionId));
  return interaction;
}

/** Marks open interactions as dealt with elsewhere, usually at the keyboard. */
export function closeOpen(sessionId: string, by: string, kinds?: InteractionKind[]): void {
  const open = listInteractions({ sessionId, status: "open" }).filter((item) => !kinds || kinds.includes(item.kind));
  if (!open.length) return;
  const update = db.prepare("UPDATE interactions SET status = 'closed', answered_by = ?, updated_at = ? WHERE id = ?");
  for (const item of open) {
    update.run(by, now(), item.id);
    void acknowledgeOnChannels(item, by === "superseded" ? null : `Answered in the ${by}.`);
  }
  broadcast("interactions", { sessionId });
}

export class AnswerError extends Error {}

/** Option numbers for a question: "2", or "1,3" for several questions. Anything else is a typed answer. */
async function answerQuestion(interaction: Interaction, answer: string): Promise<void> {
  const terminal = terminalForSession(interaction.sessionId)!;
  const questions: Array<{ options?: unknown[] }> = interaction.data.questions ?? [];
  // One line per question (the dashboard), or "1,2" typed on a channel; lines keep typed answers with commas whole.
  const split = answer.includes("\n") ? answer.split("\n") : answer.split(/[;,]/);
  const parts = questions.length > 1 ? split.map((part) => part.trim()) : [answer.trim()];
  for (let index = 0; index < Math.max(questions.length, 1); index += 1) {
    const part = parts[index] ?? parts[parts.length - 1] ?? "";
    const optionCount = questions[index]?.options?.length ?? 0;
    const number = Number(part);
    if (Number.isInteger(number) && number >= 1 && number <= optionCount) {
      await pressKeys(terminal, String(number));
    } else {
      // The free-text entry comes after the listed options.
      await pressKeys(terminal, String(optionCount + 1));
      await typeMessage(terminal, part);
    }
  }
  // Several questions end on a review step that submits with Enter.
  if (questions.length > 1) await pressKeys(terminal, "\r");
}

async function answerPermission(interaction: Interaction, answer: string): Promise<void> {
  const terminal = terminalForSession(interaction.sessionId)!;
  const word = answer.trim().toLowerCase();
  if (["1", "y", "yes", "allow", "ok", "approve"].includes(word)) return pressKeys(terminal, "1");
  if (["2", "always", "allow always"].includes(word)) return pressKeys(terminal, "2");
  if (["3", "n", "no", "deny", "reject"].includes(word)) return pressKeys(terminal, "\x1b");
  // Denied with a reason: Escape rejects, then the reason becomes the next message.
  await pressKeys(terminal, "\x1b");
  await typeMessage(terminal, answer);
}

/**
 * Hands the answer to the session. Imported lazily by name to keep the MCP
 * module, which resumes sessions, out of this one's import cycle.
 */
async function answerMcp(interaction: Interaction, answer: string, by: string): Promise<void> {
  const { installSuggestion, skipSuggestion } = await import("./mcpSuggestions.js");
  const word = answer.trim().toLowerCase();
  if (["install", "yes", "y", "1"].includes(word)) {
    await installSuggestion(interaction.data.suggestionId, by);
    return;
  }
  if (["skip", "no", "n", "2"].includes(word)) {
    await skipSuggestion(interaction.data.suggestionId, "");
    return;
  }
  await skipSuggestion(interaction.data.suggestionId, answer);
}

export async function answerInteraction(id: string, answer: string, by: string): Promise<Interaction> {
  const interaction = getInteraction(id);
  if (!interaction) throw new AnswerError("No such interaction.");
  if (interaction.status !== "open") throw new AnswerError(`Already ${interaction.status}${interaction.answeredBy ? ` by ${interaction.answeredBy}` : ""}.`);
  if (!answer.trim()) throw new AnswerError("The answer is empty.");
  const terminal = terminalForSession(interaction.sessionId);
  // An MCP install resumes the session itself, so it does not need a live one.
  if (!terminal && interaction.kind !== "mcp") throw new AnswerError("That session is no longer running. Resume it from the dashboard first.");

  // Claimed before typing, so a second channel answering at the same moment loses cleanly.
  const claimed = db
    .prepare("UPDATE interactions SET status = 'answered', answered_by = ?, answer = ?, updated_at = ? WHERE id = ? AND status = 'open'")
    .run(by, answer, now(), id);
  if (!claimed.changes) throw new AnswerError("Someone else answered first.");

  if (interaction.kind === "permission") await answerPermission(interaction, answer);
  else if (interaction.kind === "question") await answerQuestion(interaction, answer);
  else if (interaction.kind === "mcp") await answerMcp(interaction, answer, by);
  else if (terminal) await typeMessage(terminal, answer);

  setSessionStatus(interaction.sessionId, "running");
  broadcast("interactions", { sessionId: interaction.sessionId });
  const answered = getInteraction(id)!;
  void acknowledgeOnChannels(answered, `Answered by ${by}: ${answer.length > 200 ? `${answer.slice(0, 200)}...` : answer}`);
  return answered;
}

/** How an interaction that is no longer open ended, in words for whoever replied to it late. */
function ended(interaction: Interaction): string {
  const by = interaction.answeredBy ?? "";
  if (interaction.status === "answered") return `That was already answered${by ? ` by ${by.replace(/^(telegram|slack):/, "")}` : ""}${interaction.answer ? `: ${interaction.answer.slice(0, 80)}` : ""}.`;
  if (by === "superseded") return "That question is over: the session moved on.";
  if (by === "hub restart") return "That question went away when the hub restarted.";
  if (by === "session end") return "That session ended before it was answered.";
  return by ? `That was already answered in the ${by}.` : "That question is over.";
}

/** What a session that has moved on asks now, as a pointer: the newer message is the one to answer. */
function newer(sessionId: string): string {
  const open = listInteractions({ sessionId, status: "open" })[0];
  return open ? ` It is waiting on something newer now ("${open.title}"): reply to that message instead.` : "";
}

/**
 * A reply from a channel that may or may not name what it answers. It goes to
 * the interaction it names, else to the newest open one on the session, else,
 * when the session is live, straight in as the next message, and when it has
 * stopped, the session is resumed with it.
 *
 * A reply to a question or a permission that is over never answers another
 * one: a late "yes" to an old dialog must not approve the dialog showing now.
 * A reply to the end of a turn (or a done report) continues the conversation,
 * unless the session now waits on a dialog.
 */
export async function routeReply(input: { sessionId?: string | null; interactionId?: string | null; text: string; by: string; choice?: string }): Promise<string> {
  if (input.interactionId) {
    const target = getInteraction(input.interactionId);
    if (input.choice) {
      if (!target || target.status !== "open") return target ? `${ended(target)}${newer(target.sessionId)}` : "That question is gone.";
      const answered = await chooseInteraction(target.id, input.choice, input.by);
      return `Sent: ${answered.answer}`;
    }
    if (target?.status === "open") {
      await answerInteraction(target.id, input.text, input.by);
      return "Sent to the session.";
    }
    if (!target) return "That question is gone.";
    if (target.kind !== "turn" && target.kind !== "done") return `${ended(target)}${newer(target.sessionId)}`;
    const current = listInteractions({ sessionId: target.sessionId, status: "open" })[0];
    if (current && current.kind !== "turn") return `The session has moved on since that message.${newer(target.sessionId)}`;
    input.sessionId ??= target.sessionId;
  }
  let sessionId = input.sessionId ?? null;
  if (!sessionId) {
    // Nothing to go on: it can only mean the one thing currently waiting.
    const open = listInteractions({ status: "open" });
    if (open.length === 1) sessionId = open[0].sessionId;
    else if (open.length > 1) return "Several sessions are waiting. Reply in the thread (or to the message) of the one you mean.";
    else return "No session is waiting for an answer.";
  }
  const open = listInteractions({ sessionId, status: "open" })[0];
  if (open) {
    await answerInteraction(open.id, input.text, input.by);
    return "Sent to the session.";
  }
  const terminal = terminalForSession(sessionId);
  if (!terminal) {
    // Stopped (or the hub restarted since): picked up again with the message, as a person would from the dashboard.
    const session = listSessions().find((item) => item.id === sessionId);
    if (!session) return "That session is gone.";
    if (session.origin === "external" && session.live) return "That session is running outside the hub, so the hub cannot type into it.";
    const { resumeWith } = await import("./channels/commands.js");
    return resumeWith(sessionId, input.text) as string;
  }
  await typeMessage(terminal, input.text);
  setSessionStatus(sessionId, "running");
  return "Sent to the session as a new message.";
}

/**
 * A permission dialog or a question answered at the keyboard fires no hook.
 * The signal is the tool's result landing in the transcript: it is written
 * only once the dialog is answered (or the tool denied). The transcript merely
 * growing is not enough; other hooks keep writing to it while a dialog waits.
 */
export function startInteractionSweeper(intervalMs = 2000): () => void {
  // Ticks for the project that started the sweeper.
  const timer = setInterval(bindProject(() => {
    for (const item of listInteractions({ status: "open" })) {
      if (item.kind !== "permission" && item.kind !== "question") continue;
      const result = lastToolResultAt(item.sessionId);
      if (result && Date.parse(result) > Date.parse(item.createdAt)) {
        closeOpen(item.sessionId, "terminal", [item.kind]);
        if (terminalForSession(item.sessionId)) setSessionStatus(item.sessionId, "running");
      }
    }
  }), intervalMs);
  return () => clearInterval(timer);
}
