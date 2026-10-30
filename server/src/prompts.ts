import { globalDb, now } from "./db.js";

/**
 * Every word the hub itself puts in front of Claude or a human, in one place.
 * Each can be rewritten from the dashboard and restored to its default, and
 * nothing reads a default directly: it all goes through promptText().
 *
 * Placeholders are {{name}}. An unknown one is left as written.
 */
export interface PromptDefinition {
  key: string;
  label: string;
  /** Who reads it: Claude (system prompt or typed into the session) or a person on a channel. */
  audience: "claude-system" | "claude-typed" | "channel";
  description: string;
  placeholders: string[];
  text: string;
}

const DEFAULTS: PromptDefinition[] = [
  {
    key: "system.base",
    label: "Appended to every session the hub starts",
    audience: "claude-system",
    description: "Passed with --append-system-prompt-file. It adds to Claude Code's own system prompt, never replaces it.",
    placeholders: ["project"],
    text: `# Running under Clauder Hub

This session was started from Clauder Hub, a local dashboard for the project at {{project}}. A person may be answering you from the terminal or from a chat channel (Slack, Telegram, ...), so keep questions short and self-contained.

## Asking the person

When you need the person to decide or answer something before you can go on, ask with the AskUserQuestion tool rather than in prose: one short question, 2 to 4 concrete options with a one-line description each, your recommended option first. They answer it with one tap, from the dashboard or a chat app. Ask in prose only when the answer cannot be a choice (a name, a value, an explanation), and then end your message with that one question.`,
  },
  {
    key: "system.mcp",
    label: "MCP suggestions, when turned on",
    audience: "claude-system",
    description: "Appended after the base prompt only while MCP suggestions are on (MCP suggestions page). It lets a blocked session ask for an MCP server.",
    placeholders: [],
    text: `## When a missing integration blocks you

Only when you are genuinely stuck because a tool or integration you need is not available (for example the task needs Jira tickets and no Jira MCP server or CLI is reachable), and there is no reasonable way around it with the tools you have (Bash, curl, a CLI already installed, files in the repo):

1. Do not keep trying workarounds and do not continue the task.
2. End your message with exactly this block, the JSON on one line:

<<CLAUDER_MCP_SUGGEST>>
{"name":"<short server name>","reason":"<why the task needs it>","command":"claude mcp add --scope project <name> ...","docs":"<url of the server's docs, if known>"}
<</CLAUDER_MCP_SUGGEST>>

3. Stop and wait. The person will install it (the session is then resumed) or tell you to carry on without it.

Do not suggest a server for something you can already do, and never suggest one just in case.`,
  },
  {
    key: "system.setup",
    label: "A session's own setup",
    audience: "claude-system",
    description: "Appended when the person filled in the session's Setup tab. {{notes}} is their text, {{variables}} one '- NAME: value' line each.",
    placeholders: ["notes", "variables"],
    text: `## Set up for this session

The person set this up for this session only. Follow it for the whole session, unless a message of theirs says otherwise.

{{notes}}

Names they may use, and what each stands for:
{{variables}}`,
  },
  {
    key: "system.done",
    label: "Done protocol, for sessions with a task category",
    audience: "claude-system",
    description: "Appended after the base prompt when a session has a category, which every triggered run has. The hub closes the session only once this block arrives with every required deliverable.",
    placeholders: ["category", "categories"],
    text: `## Finishing the task

This session runs unattended and is closed by the hub when you report the task as done. Category: {{category}}.

The categories and what each needs before it counts as done:

{{categories}}

When, and only when, the whole task is complete and every required deliverable exists, end your final message with this block (the JSON may span lines):

<<CLAUDER_DONE>>
{"category":"<one of the category names above>","summary":"<two or three sentences>","deliverables":{"<deliverable name>":"<link, path or short evidence>"}}
<</CLAUDER_DONE>>

If the category was given as "auto", choose the one that fits the task best. Do not send the block to ask a question or to report partial progress; if you are blocked, say so plainly and wait.`,
  },
  {
    key: "typed.missing",
    label: "Typed into a session that reported done too early",
    audience: "claude-typed",
    description: "Sent when the done block is missing required deliverables or names an unknown category.",
    placeholders: ["problems"],
    text: `Clauder Hub: the task is not closed yet.

{{problems}}

Finish what is missing, then send the done block again.`,
  },
  {
    key: "typed.addMcp",
    label: "First message of an Add MCP server task",
    audience: "claude-typed",
    description: "Typed into the hub task the MCP servers page opens, so it starts at once: {{server}} is the server's name from the catalog.",
    placeholders: ["server"],
    text: "Add the {{server}} MCP server to this project. Check whether it is already configured, then tell me what you need from me, if anything, and add it once I confirm.",
  },
  {
    key: "typed.addAnyMcp",
    label: "First message of an Add another MCP server task",
    audience: "claude-typed",
    description: "Typed into the hub task opened by Add another server, so it starts at once.",
    placeholders: [],
    text: "I want to add an MCP server to this project. Ask me which one, then tell me what you need from me and add it once I confirm.",
  },
  {
    key: "typed.findFolders",
    label: "Finding a folder for /addproject",
    audience: "claude-typed",
    description: "Asked of a small model, with no tools, when someone describes a project to add on a global channel instead of giving its path. {{folders}} are the project-looking folders found on this machine, numbered.",
    placeholders: ["request", "folders"],
    text: `Someone wants to add one of the folders below to a dashboard as a project, and described it like this (any language):

"{{request}}"

Folders on their computer:
{{folders}}

Answer with only a JSON array of the numbers of the folders that could be what they mean, best match first, at most 6, for example [12, 3]. Match on meaning, not only on spelling: "my calendar app" may be "project-calendar". Answer [] if none fits.`,
  },
  {
    key: "typed.pickMatches",
    label: "Matching what a chat command named",
    audience: "claude-typed",
    description: "Asked of a small model, with no tools, when a channel command names a session or project that matches nothing exactly (a typo, a description). {{what}} is what is listed, {{options}} the numbered list.",
    placeholders: ["request", "what", "options"],
    text: `Someone typed this in a chat to name one of the {{what}} below (any language, maybe misspelled or described):

"{{request}}"

The {{what}}:
{{options}}

Answer with only a JSON array of the numbers that could be what they mean, best match first, at most 4, for example [3, 1]. Answer [] if none fits.`,
  },
  {
    key: "typed.interpretCommand",
    label: "Understanding a chat message the hub could not place",
    audience: "claude-typed",
    description: "Asked of a small model, with no tools, when a channel message is an unknown command, or plain text with no session to go to. Its guesses come back as buttons; nothing runs until one is pressed.",
    placeholders: ["text", "commands", "sessions"],
    text: `A person typed this to a chat bot that runs Claude Code sessions for a software project (any language, maybe misspelled):

"{{text}}"

The bot's commands (written here without the leading slash):
{{commands}}

The sessions, numbered as the commands take them:
{{sessions}}

Which commands did they most likely mean? Answer with only a JSON array of full command strings, best first, at most 3, for example ["summary 2", "sessions"]. Put a task they describe into new (or run, when they want it done unattended), in their own words. Answer [] if it is just chatter or nothing fits.`,
  },
  {
    key: "typed.mcpInstalled",
    label: "First message after an MCP is installed",
    audience: "claude-typed",
    description: "The session is resumed with this prompt once the suggested MCP server is installed.",
    placeholders: ["name"],
    text: "Clauder Hub: the MCP server '{{name}}' is now installed for this project and loaded in this session. Continue the task.",
  },
  {
    key: "typed.mcpSkipped",
    label: "Typed when the suggestion is declined",
    audience: "claude-typed",
    description: "Sent when the person chooses to carry on without the suggested MCP server.",
    placeholders: ["name", "note"],
    text: "Clauder Hub: the MCP server '{{name}}' will not be installed. Carry on without it, using what is already available. {{note}}",
  },
  {
    key: "channel.permission",
    label: "Channel message: permission request",
    audience: "channel",
    description: "Sent to every channel when Claude asks to use a tool.",
    placeholders: ["session", "tool", "input"],
    text: `*{{session}}* asks to use *{{tool}}*
\`\`\`
{{input}}
\`\`\`
Reply *1* allow, *2* allow for the rest of the session, *3* deny. Anything else denies and is sent to Claude as the reason.`,
  },
  {
    key: "channel.question",
    label: "Channel message: Claude asks a question",
    audience: "channel",
    description: "Sent when Claude uses AskUserQuestion.",
    placeholders: ["session", "question", "options"],
    text: `*{{session}}* asks:
{{question}}

{{options}}

Reply with the option number, or with your own answer.`,
  },
  {
    key: "channel.turn",
    label: "Channel message: Claude is waiting for you",
    audience: "channel",
    description: "Sent when Claude ends a turn and the session waits for the next message.",
    placeholders: ["session", "message"],
    text: `*{{session}}* is waiting for you:
{{message}}

Reply here to send your answer to the session.`,
  },
  {
    key: "channel.mcp",
    label: "Channel message: MCP suggested",
    audience: "channel",
    description: "Sent when a session is blocked on a missing integration.",
    placeholders: ["session", "name", "reason", "command"],
    text: `*{{session}}* is blocked and suggests installing the MCP server *{{name}}*.
{{reason}}
\`\`\`
{{command}}
\`\`\`
Reply *install* to run it (project scope) and resume the session, or *skip* to carry on without it.`,
  },
  {
    key: "channel.done",
    label: "Channel message: task done",
    audience: "channel",
    description: "Sent when a session reports done and the hub closes it.",
    placeholders: ["session", "category", "summary", "deliverables"],
    text: `*{{session}}* is done ({{category}}).
{{summary}}

{{deliverables}}`,
  },
  {
    key: "channel.help",
    label: "Channel command: help",
    audience: "channel",
    description: "The answer to /help and /start on a channel ({{p}} is the command prefix: / on Telegram, ! on Slack).",
    placeholders: ["project", "p"],
    text: `This channel works with the project {{project}}.

{{p}}new - start a session (with a prompt, or I ask for one)
{{p}}run - queue an unattended run
{{p}}sessions - the sessions, to pick one
{{p}}summary - what a session did
{{p}}stop - stop a running session
{{p}}queue - the run queue
{{p}}cancel - drop what I was asking for, and the picked session
{{p}}help - this list

To talk to a session, pick it in {{p}}sessions (then just type), or reply to one of its messages. {{p}}cancel lets go of it.`,
  },
  {
    key: "channel.askNew",
    label: "Channel command: asking for a new session's prompt",
    audience: "channel",
    description: "Sent when {{p}}new comes without a prompt; the next message becomes it.",
    placeholders: ["p"],
    text: "What should the new session do? Send the prompt as your next message, or {{p}}cancel.",
  },
  {
    key: "channel.askRun",
    label: "Channel command: asking for a run's prompt",
    audience: "channel",
    description: "Sent when {{p}}run comes without a prompt; the next message becomes it.",
    placeholders: ["p"],
    text: "What should the run do? Send the prompt as your next message, or {{p}}cancel.",
  },
  {
    key: "channel.started",
    label: "Channel command: session started",
    audience: "channel",
    description: "Sent when a session was started from the channel. Replies to this message go to it.",
    placeholders: ["prompt"],
    text: `{{prompt}}

Reply to this message to talk to the session. Its questions come here too.`,
  },
  {
    key: "channel.queued",
    label: "Channel command: run queued",
    audience: "channel",
    description: "Sent when a run was queued from the channel.",
    placeholders: ["position"],
    text: "Queued, number {{position}} in line. Runs go one at a time; its questions and its result come here.",
  },
  {
    key: "channel.globalHelp",
    label: "Global channel command: help",
    audience: "channel",
    description: "The answer to /help on a global channel, which serves every project ({{p}} is / or !, {{current}} the project picked).",
    placeholders: ["p", "current"],
    text: `This channel serves every project in the hub. Questions and replies from all of them arrive here, each named after its project; reply to one and it goes back to that session.

{{p}}projects - the projects, to pick one
{{p}}use <project> - work on a project
{{p}}addproject <words> - add a project: describe it, I find the folder
Then, on that project: {{p}}new, {{p}}run, {{p}}sessions, {{p}}summary, {{p}}stop, {{p}}queue, {{p}}cancel.

Working on: {{current}}`,
  },
  {
    key: "channel.askPath",
    label: "Global channel command: asking for a folder to add",
    audience: "channel",
    description: "Sent when {{p}}addproject comes alone; the next message describes the folder (or is its path).",
    placeholders: ["p"],
    text: "Which project? Describe it in your own words, like \"the calendar app\" or \"agent portal\", and I will find the folders that fit. A full path works too. Or {{p}}cancel.",
  },
  {
    key: "channel.noFolder",
    label: "Global channel command: no folder fits",
    audience: "channel",
    description: "Sent when no project-looking folder on the machine fits what {{p}}addproject was told; the next message is another try.",
    placeholders: ["request", "p"],
    text: "I found no project folder that looks like \"{{request}}\". Describe it another way (its name, what it does), or send its full path. Or {{p}}cancel.",
  },
  {
    key: "channel.stopConfirm",
    label: "Channel command: confirming a stop",
    audience: "channel",
    description: "Asked before a session is stopped from the channel.",
    placeholders: ["session"],
    text: "Stop {{session}}? Its terminal closes; the conversation is kept and can be resumed from the dashboard.",
  },
];

export function promptDefinitions(): Array<PromptDefinition & { defaultText: string; overridden: boolean }> {
  const overrides = new Map(
    (globalDb.prepare("SELECT key, text FROM prompt_overrides").all() as Array<{ key: string; text: string }>).map((row) => [row.key, row.text]),
  );
  return DEFAULTS.map((item) => ({
    ...item,
    defaultText: item.text,
    text: overrides.get(item.key) ?? item.text,
    overridden: overrides.has(item.key),
  }));
}

export function promptText(key: string): string {
  const row = globalDb.prepare("SELECT text FROM prompt_overrides WHERE key = ?").get(key) as { text: string } | undefined;
  if (row) return row.text;
  const fallback = DEFAULTS.find((item) => item.key === key);
  if (!fallback) throw new Error(`Unknown prompt '${key}'.`);
  return fallback.text;
}

export function setPrompt(key: string, text: string | null): void {
  if (!DEFAULTS.some((item) => item.key === key)) throw new Error(`Unknown prompt '${key}'.`);
  if (text === null) globalDb.prepare("DELETE FROM prompt_overrides WHERE key = ?").run(key);
  else
    globalDb.prepare("INSERT INTO prompt_overrides (key, text, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at").run(
      key,
      text,
      now(),
    );
}

export function render(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, name: string) => (name in values ? values[name] : whole));
}

export function renderPrompt(key: string, values: Record<string, string>): string {
  return render(promptText(key), values).trim();
}
