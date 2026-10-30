import { bindProject, currentProject } from "../context.js";
import { db, now } from "../db.js";
import { cancelRun, enqueue, listRuns } from "../jobs.js";
import { renderPrompt } from "../prompts.js";
import { askSmallModel, jsonIn, pickNumbers } from "../smallModel.js";
import { listSessions, startSession, type SessionView } from "../sessions.js";
import { killTerminal, terminalForSession } from "../terminals.js";
import { transcriptDetail } from "../transcripts.js";
import type { ChannelAnswer, ChannelCard, SentMessage } from "./types.js";

/**
 * Commands typed into a channel, in the manner of Telegram's BotFather: a
 * menu of commands, buttons to pick from instead of ids to type, and a
 * question when something is missing ("/new" alone asks for the prompt, and
 * the next message is it). They act on the channel's project. A message in a
 * session's thread, or a reply to one, is never a command: "/compact" there
 * is meant for Claude.
 */
const COMMAND = /^[/!]([a-z]+!?)(?:@\S+)?(?:\s+([\s\S]*))?$/i;

/** What a channel asked for and waits on: the next plain message is the prompt. */
const awaiting = new Map<string, "new" | "run">();
/**
 * The session someone picked (or started here): their plain messages go to it,
 * as BotFather's commands act on the bot picked. Only theirs, since a Slack
 * channel has other people talking in it, and only while they keep using it.
 */
const focused = new Map<string, { sessionId: string; from: string; at: number }>();
const FOCUS_IDLE_MS = 60 * 60_000;
/** The numbers the last /sessions list gave, so "/summary 2" means what was shown. */
const numbered = new Map<string, string[]>();
const keyOf = (channelId: string) => `${currentProject().id}:${channelId}`;

/** Telegram has a / command menu; Slack takes a typed "/" as its own slash command, so there it is "!". */
/**
 * How a channel outside this project runs a command here (a global channel):
 * its own prefix, and where a session it starts is bound, in its own database.
 */
export interface CommandOptions {
  prefix?: string;
  bind?: (sessionId: string) => (sent: SentMessage) => void;
}

function prefixOf(channelId: string): string {
  const row = db.prepare("SELECT kind FROM channels WHERE id = ?").get(channelId) as { kind: string } | undefined;
  return row?.kind === "slack" ? "!" : "/";
}

export function isCommand(text: string): boolean {
  return COMMAND.test(text.trim());
}

const HUB_COMMANDS = new Set(["start", "help", "new", "run", "cancel", "leave", "sessions", "session", "summary", "stop", "stop!", "queue", "cancelrun"]);

/** One of the hub's own commands; any other "/word" (Claude's /compact, /clear...) is for the picked session. */
export function isHubCommand(text: string): boolean {
  const name = COMMAND.exec(text.trim())?.[1]?.toLowerCase();
  return Boolean(name && HUB_COMMANDS.has(name));
}

/** A prompt asked for by /new or /run, if the channel is waiting on one. */
export function takesPrompt(channelId: string): boolean {
  return awaiting.has(keyOf(channelId));
}

/** The session this person's plain messages go to, if they picked one, still use it, and it still exists. */
export function focusedSession(channelId: string, from: string): string | null {
  const key = keyOf(channelId);
  const focus = focused.get(key);
  if (!focus || focus.from !== from) return null;
  if (Date.now() - focus.at > FOCUS_IDLE_MS || !listSessions().some((session) => session.id === focus.sessionId)) {
    focused.delete(key);
    return null;
  }
  focus.at = Date.now();
  return focus.sessionId;
}

function focus(channelId: string, sessionId: string, from: string): void {
  focused.set(keyOf(channelId), { sessionId, from, at: Date.now() });
}

/** A message for the picked session when it has stopped: it is resumed with the message as its next prompt. */
export function resumeWith(sessionId: string, text: string): ChannelAnswer {
  const session = listSessions().find((item) => item.id === sessionId);
  startSession({ resumeId: sessionId, prompt: text });
  return `▶️ Resumed ${session?.title ?? "the session"} with your message.`;
}

const short = (text: string, length: number) => (text.length > length ? `${text.slice(0, length - 1)}…` : text);
const flat = (text: string) => text.replace(/\s+/g, " ").trim();

const STATUS: Record<string, string> = { waiting: "⏳ waiting for you", running: "▶️ running", done: "✅ done", exited: "⏹ stopped", external: "outside the hub" };

/** The sessions worth offering: every live one, then the latest few that stopped. */
function pickable(): SessionView[] {
  const sessions = listSessions().filter((session) => session.origin !== "external" || session.live);
  const live = sessions.filter((session) => session.live || session.status === "waiting");
  const rest = sessions.filter((session) => !live.includes(session)).slice(0, 5);
  return [...live, ...rest];
}

/** A session by its number in the last /sessions list, its id, or an id prefix of 4 or more that fits only one. */
function find(channelId: string, arg: string): SessionView | null {
  const sessions = listSessions();
  const wanted = arg.trim().toLowerCase();
  if (!wanted) return null;
  if (/^\d+$/.test(wanted)) {
    const id = (numbered.get(keyOf(channelId)) ?? pickable().map((session) => session.id))[Number(wanted) - 1];
    return sessions.find((session) => session.id === id) ?? null;
  }
  const exact = sessions.find((session) => session.id === wanted);
  if (exact) return exact;
  const matches = wanted.length >= 4 ? sessions.filter((session) => session.id.startsWith(wanted)) : [];
  return matches.length === 1 ? matches[0] : null;
}

/** A list of sessions as buttons, each running `action` on its session. */
function sessionPicker(channelId: string, title: string, action: string, sessions: SessionView[], empty: string): ChannelAnswer {
  if (!sessions.length) return empty;
  // Typed numbers follow the full list, not a narrowed one like /stop's.
  if (action === "session") numbered.set(keyOf(channelId), sessions.map((session) => session.id));
  return {
    title,
    buttons: sessions.slice(0, 15).map((session, index) => [{ label: short(`${index + 1}. ${session.title} · ${STATUS[session.status] ?? session.status}`, 60), command: `${action} ${session.id}` }]),
  };
}

function sessionCard(session: SessionView): ChannelCard {
  const detail = transcriptDetail(session.id);
  return {
    title: `💬 ${session.title}`,
    lines: [
      `${STATUS[session.status] ?? session.status} · ${session.lastAt ? `last active ${new Date(session.lastAt).toLocaleString()}` : "not started yet"}`,
      session.live ? "Your next messages go to this session." : "Your next message resumes this session with it.",
    ],
    quote: detail?.lastAssistantText ? short(detail.lastAssistantText.trim(), 600) : undefined,
    buttons: [
      [
        { label: "📝 Summary", command: `summary ${session.id}` },
        ...(session.live ? [{ label: "⏹ Stop", command: `stop ${session.id}`, tone: "danger" as const }] : []),
      ],
      [
        { label: "⬅️ Sessions", command: "sessions" },
        { label: "✖️ Leave", command: "leave" },
      ],
    ],
  };
}

/** What a session did, read from its transcript: nothing is asked of Claude, so it costs no tokens and works on a stopped one. */
function summaryCard(session: SessionView): ChannelCard {
  const detail = transcriptDetail(session.id);
  const lines = [`${STATUS[session.status] ?? session.status} · ${detail?.turns ?? 0} prompts · ${detail?.toolCalls ?? 0} tool calls`];
  if (detail) {
    const tokens = detail.totals.tokens;
    const total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreation;
    lines.push(`Tokens: ${total.toLocaleString()} (${tokens.output.toLocaleString()} written)`);
    const edited = [...new Set(detail.recent.filter((call) => ["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(call.name)).map((call) => call.summary).filter(Boolean))];
    if (edited.length) lines.push(`Files changed: ${edited.slice(0, 8).map((file) => file.split(/[\\/]/).pop()).join(", ")}${edited.length > 8 ? ` and ${edited.length - 8} more` : ""}`);
    const tools = Object.entries(detail.totals.tools)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 5)
      .map(([name, item]) => `${name} ${item.count}`);
    if (tools.length) lines.push(`Most used: ${tools.join(", ")}`);
    if (detail.firstPrompt) lines.push(`Asked: ${short(flat(detail.firstPrompt), 200)}`);
  }
  return {
    title: `📝 ${session.title}`,
    lines,
    quote: detail?.lastAssistantText ? short(detail.lastAssistantText.trim(), 1200) : "Claude has not answered yet.",
    buttons: [[...(session.live ? [{ label: "⏹ Stop", command: `stop ${session.id}`, tone: "danger" as const }] : []), { label: "⬅️ Sessions", command: "sessions" }]],
  };
}

/**
 * A reply to the card that started a session goes to that session, and its
 * later questions thread under the card, as for a session the hub announced.
 */
function bindToSession(channelId: string, sessionId: string): (sent: SentMessage) => void {
  return bindProject((sent: SentMessage) => {
    const thread = sent.thread ?? sent.ref;
    // Slack routes a reply by its thread, Telegram by the message replied to: both lead here.
    for (const ref of new Set([sent.ref, thread])) {
      db.prepare("INSERT OR REPLACE INTO channel_refs (channel_id, ref, session_id, interaction_id, created_at) VALUES (?, ?, ?, NULL, ?)").run(channelId, ref, sessionId, now());
    }
    db.prepare("INSERT OR REPLACE INTO channel_threads (channel_id, session_id, thread) VALUES (?, ?, ?)").run(channelId, sessionId, thread);
  });
}

function startFromChannel(channelId: string, prompt: string, from: string, options: CommandOptions): ChannelAnswer {
  const terminal = startSession({ prompt, origin: "manual" });
  // What is typed next is for the session just started.
  focus(channelId, terminal.sessionId, from);
  return {
    title: "▶️ New session started",
    lines: [renderPrompt("channel.started", { prompt: short(flat(prompt), 300) })],
    buttons: [[{ label: "📝 Summary", command: `summary ${terminal.sessionId}` }, { label: "⏹ Stop", command: `stop ${terminal.sessionId}`, tone: "danger" }]],
    onSent: (options.bind ?? ((sessionId: string) => bindToSession(channelId, sessionId)))(terminal.sessionId),
  };
}

function queueFromChannel(prompt: string): ChannelAnswer {
  const { position } = enqueue({ source: "manual", prompt, category: "auto" });
  return { title: "🗂 Run queued", lines: [renderPrompt("channel.queued", { position: String(position) })], buttons: [[{ label: "🗂 Queue", command: "queue" }]] };
}

function queueCard(): ChannelAnswer {
  const runs = listRuns(50).filter((run) => run.status === "queued" || run.status === "running");
  if (!runs.length) return "The queue is empty.";
  return {
    title: "🗂 Queue",
    lines: runs.map((run, index) => `${index + 1}. ${run.status === "running" ? "▶️" : "⏳"} ${short(flat(run.jobName ?? run.prompt), 80)}`),
    buttons: runs.filter((run) => run.status === "queued").slice(0, 10).map((run) => [{ label: short(`✖️ Cancel: ${flat(run.jobName ?? run.prompt)}`, 60), command: `cancelrun ${run.id}` }]),
  };
}

/** A prompt the channel was asked for, typed as the next message. */
export function answerPrompt(channelId: string, text: string, from: string, options: CommandOptions = {}): ChannelAnswer {
  const key = keyOf(channelId);
  const kind = awaiting.get(key);
  const answer = kind === "run" ? queueFromChannel(text) : startFromChannel(channelId, text, from, options);
  // Only once it worked: a failed start (Claude missing) leaves the question open for another try.
  awaiting.delete(key);
  return answer;
}

// When what was typed does not fit ---------------------------------------------

/** Guesses offered as buttons, for the press that runs one: <project id>:<channel id>:<who>. */
const suggested = new Map<string, string[]>();
const suggestKey = (channelId: string, from: string) => `${keyOf(channelId)}:${from}`;

/** Buttons for commands Claude thinks were meant; each runs only when pressed (commands too long for Telegram's button data are kept here). */
function suggestCard(channelId: string, from: string, title: string, choices: Array<{ label: string; command: string }>, lines: string[] = []): ChannelCard {
  suggested.set(suggestKey(channelId, from), choices.map((choice) => choice.command));
  return {
    title,
    lines,
    buttons: [...choices.map((choice, index) => [{ label: short(choice.label, 60), command: `suggest ${index + 1}` }]), [{ label: "Cancel", command: "cancel" }]],
  };
}

const sessionLine = (session: SessionView, index: number) =>
  `${index + 1}. ${session.title} · ${STATUS[session.status] ?? session.status}${session.firstPrompt ? ` · asked: ${short(flat(session.firstPrompt), 120)}` : ""}`;

/** A session named by a typo or a description ("the login bug"): Claude matches it against the sessions, and they come back as buttons. */
async function sessionGuess(channelId: string, from: string, action: string, request: string, p: string): Promise<ChannelAnswer> {
  // Only a running session can be stopped, so only those are offered for it.
  const sessions = action === "stop" ? pickable().filter((session) => session.live) : pickable();
  if (!sessions.length) return action === "stop" ? "No session is running." : `No sessions yet. ${p}new starts one.`;
  numbered.set(keyOf(channelId), sessions.map((session) => session.id));
  const picked = (await pickNumbers(renderPrompt("typed.pickMatches", { request, what: "sessions", options: sessions.map(sessionLine).join("\n") }))) ?? [];
  const matches = picked.map((number) => sessions[number - 1]).filter((session): session is SessionView => Boolean(session));
  if (!matches.length) return `No session like "${short(request, 60)}". ${p}sessions lists them.`;
  return suggestCard(
    channelId,
    from,
    "🤔 Which session did you mean?",
    matches.map((session) => ({ label: `${session.title} · ${STATUS[session.status] ?? session.status}`, command: `${action} ${session.id}` })),
  );
}

/** What each command takes, for Claude to map a message onto. */
const COMMAND_GUIDE = [
  "new <what the session should do> - start a session",
  "run <what to do> - queue an unattended run",
  "sessions - list the sessions",
  "session <number> - pick a session, to talk to it",
  "summary <number> - what a session did",
  "stop <number> - stop a running session",
  "queue - the run queue",
  "help - the commands",
].join("\n");

/**
 * A message the hub could not place (an unknown or misspelled command, or
 * text with nowhere to go): Claude guesses the commands meant, offered as
 * buttons. Null when it has no guess.
 */
export async function interpret(channelId: string, from: string, text: string, options: CommandOptions = {}): Promise<ChannelAnswer> {
  const p = options.prefix ?? prefixOf(channelId);
  const sessions = pickable();
  numbered.set(keyOf(channelId), sessions.map((session) => session.id));
  const answer = jsonIn<unknown[]>(
    await askSmallModel(renderPrompt("typed.interpretCommand", { text, commands: COMMAND_GUIDE, sessions: sessions.map(sessionLine).join("\n") || "(none yet)" })),
    "[",
  );
  const guesses = (answer ?? [])
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().replace(/^[/!]/, ""))
    // Only the hub's own commands, and never one that acts without its own confirmation.
    .filter((item) => GUESSABLE.has(item.split(/\s+/)[0].toLowerCase()))
    .slice(0, 3);
  if (!guesses.length) return null;
  // "stop 3" reads as the session it means, and runs on that session's id, whatever the numbers become.
  const choices = guesses.map((command) => {
    const [name, arg = ""] = command.split(/\s+(.*)/s);
    const session = /^\d+$/.test(arg.trim()) ? sessions[Number(arg) - 1] : undefined;
    return session ? { label: `${p}${name} · ${session.title}`, command: `${name} ${session.id}` } : { label: `${p}${command}`, command };
  });
  return suggestCard(channelId, from, "🤔 Did you mean?", choices);
}

const GUESSABLE = new Set(["new", "run", "sessions", "session", "summary", "stop", "queue", "help"]);

/** Runs a typed command ("/new fix the build") or a pressed button ("summary <id>"). */
export async function runCommand(channelId: string, input: string, from: string, options: CommandOptions = {}): Promise<ChannelAnswer> {
  const match = COMMAND.exec(/^[/!]/.test(input.trim()) ? input.trim() : `/${input.trim()}`);
  if (!match) return null;
  const name = match[1].toLowerCase();
  const arg = (match[2] ?? "").trim();
  const p = options.prefix ?? prefixOf(channelId);
  const key = keyOf(channelId);
  // Any other command drops a question left unanswered, so a later message is not taken as its answer.
  if (name !== "new" && name !== "run") awaiting.delete(key);

  switch (name) {
    case "start":
    case "help":
      return {
        title: `Clauder Hub · ${currentProject().name}`,
        lines: [renderPrompt("channel.help", { project: currentProject().name, p })],
        buttons: [
          [
            { label: "▶️ New session", command: "new", tone: "primary" },
            { label: "💬 Sessions", command: "sessions" },
          ],
          [
            { label: "🗂 Queue", command: "queue" },
            { label: "📝 Summary", command: "summary" },
          ],
        ],
      };
    case "new":
    case "run":
      if (arg) return name === "new" ? startFromChannel(channelId, arg, from, options) : queueFromChannel(arg);
      awaiting.set(key, name);
      return { title: name === "new" ? "▶️ New session" : "🗂 New run", lines: [renderPrompt(name === "new" ? "channel.askNew" : "channel.askRun", { p })], buttons: [[{ label: "Cancel", command: "cancel" }]] };
    case "cancel":
      suggested.delete(suggestKey(channelId, from));
      // The question was already dropped above; cancel also lets go of the picked session.
      return focused.delete(key) ? "Cancelled. Plain messages go nowhere until you pick a session." : "Cancelled.";
    case "leave": {
      focused.delete(key);
      return `Left the session. ${p}sessions to pick another, ${p}new to start one.`;
    }
    case "sessions":
      return sessionPicker(channelId, "💬 Sessions: pick one", "session", pickable(), `No sessions yet. ${p}new starts one.`);
    case "session": {
      const session = find(channelId, arg);
      if (!session) return arg ? sessionGuess(channelId, from, "session", arg, p) : `No such session. ${p}sessions lists them.`;
      focus(channelId, session.id, from);
      return sessionCard(session);
    }
    case "summary": {
      if (!arg) return sessionPicker(channelId, "📝 Summary of which session?", "summary", pickable(), "No sessions yet.");
      const session = find(channelId, arg);
      return session ? summaryCard(session) : sessionGuess(channelId, from, "summary", arg, p);
    }
    case "stop": {
      if (!arg) return sessionPicker(channelId, "⏹ Stop which session?", "stop", pickable().filter((session) => session.live), "No session is running.");
      const session = find(channelId, arg);
      if (!session) return sessionGuess(channelId, from, "stop", arg, p);
      if (!session.live) return `${session.title} is not running.`;
      return {
        title: "⏹ Stop the session?",
        lines: [renderPrompt("channel.stopConfirm", { session: session.title })],
        buttons: [
          [
            { label: "Yes, stop it", command: `stop! ${session.id}`, tone: "danger" },
            { label: "No", command: `session ${session.id}` },
          ],
        ],
      };
    }
    case "stop!": {
      const session = find(channelId, arg);
      const terminal = session ? terminalForSession(session.id) : undefined;
      if (!session || !terminal) return "That session is not running any more.";
      killTerminal(terminal);
      if (focused.get(key)?.sessionId === session.id) focused.delete(key);
      return `⏹ Stopped ${session.title}.`;
    }
    case "queue":
      return queueCard();
    case "cancelrun":
      cancelRun(arg);
      return queueCard();
    case "suggest": {
      // A guess offered as a button: it runs now, as if typed (a stop still asks first).
      const command = suggested.get(suggestKey(channelId, from))?.[Number(arg) - 1];
      if (!command) return `That suggestion is gone. ${p}help lists what I can do.`;
      suggested.delete(suggestKey(channelId, from));
      return runCommand(channelId, command, from, options);
    }
    default:
      return (await interpret(channelId, from, input, options)) ?? `I don't know ${p}${name}. ${p}help lists what I can do.`;
  }
}

/** A global bot's menu: picking and adding projects, then the project commands. */
export const GLOBAL_COMMAND_MENU = [
  { command: "projects", description: "Pick a project" },
  { command: "use", description: "Work on a project: /use <name>" },
  { command: "addproject", description: "Add a project: describe it, I find it" },
  { command: "new", description: "Start a session in the picked project" },
  { command: "run", description: "Queue a run in the picked project" },
  { command: "sessions", description: "The picked project's sessions" },
  { command: "summary", description: "What a session did" },
  { command: "stop", description: "Stop a running session" },
  { command: "queue", description: "The picked project's run queue" },
  { command: "cancel", description: "Drop my question or the picked session" },
  { command: "help", description: "What I can do" },
];

/** Telegram's command menu, set when the bot connects: what shows when "/" is typed. */
export const COMMAND_MENU = [
  { command: "new", description: "Start a session" },
  { command: "run", description: "Queue an unattended run" },
  { command: "sessions", description: "Pick a session" },
  { command: "summary", description: "What a session did" },
  { command: "stop", description: "Stop a running session" },
  { command: "queue", description: "The run queue" },
  { command: "cancel", description: "Drop my question or the picked session" },
  { command: "help", description: "What I can do" },
];
