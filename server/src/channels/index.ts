import { allContexts, bindProject, currentProject, isGlobal, withProject, type Project } from "../context.js";
import { nanoid } from "nanoid";
import { db, now, parseJson } from "../db.js";
import { broadcast } from "../events.js";
import type { Interaction } from "../interactions.js";
import { present } from "../presentation.js";
import { renderPrompt } from "../prompts.js";
import { pickNumbers } from "../smallModel.js";
import { terminalForSession } from "../terminals.js";
import { dashboardUrl, hubUrl, listSessions } from "../sessions.js";
import { answerPrompt, focusedSession, interpret, isCommand, isHubCommand, resumeWith, runCommand, takesPrompt, type CommandOptions } from "./commands.js";
import { createDevice, deviceInfo } from "./device.js";
import { createHttp, httpInfo } from "./http.js";
import { createSlack, slackInfo } from "./slack.js";
import { createTelegram, telegramInfo } from "./telegram.js";
import type { ChannelAdapter, ChannelAnswer, ChannelCard, ChannelKindInfo, InboundReply, SentMessage } from "./types.js";

/**
 * Every enabled channel hears about every interaction it subscribes to, all
 * at once. A reply on any of them is routed back through the interactions
 * module, where the first answer wins.
 *
 * A project's channels are its own. The global channels (the hub's global
 * context, #/global) hear from every project that is not muted there, name the
 * project in each message, and route a reply back into that project.
 */
export const CHANNEL_KINDS: ChannelKindInfo[] = [deviceInfo, slackInfo, telegramInfo, httpInfo];
export const INTERACTION_KINDS = ["permission", "question", "turn", "mcp", "done"] as const;

export interface Channel {
  id: string;
  kind: string;
  name: string;
  enabled: boolean;
  config: Record<string, string>;
  kinds: string[];
  createdAt: string;
}

interface Row {
  id: string;
  kind: string;
  name: string;
  enabled: number;
  config: string;
  kinds: string;
  created_at: string;
}

const toChannel = (row: Row): Channel => ({
  id: row.id,
  kind: row.kind,
  name: row.name,
  enabled: Boolean(row.enabled),
  config: parseJson<Record<string, string>>(row.config, {}),
  kinds: parseJson<string[]>(row.kinds, [...INTERACTION_KINDS]),
  createdAt: row.created_at,
});

/** Every project's running channels, keyed <project id>:<channel id>. */
const adapters = new Map<string, ChannelAdapter>();
const adapterKey = (channelId: string) => `${currentProject().id}:${channelId}`;

const globalContext = () => allContexts().find(isGlobal) ?? null;
const contextById = (id: string) => allContexts().find((project) => project.id === id) ?? null;

function allChannels(): Channel[] {
  return (db.prepare("SELECT * FROM channels ORDER BY created_at").all() as Row[]).map(toChannel);
}

function getChannel(id: string): Channel | null {
  const row = db.prepare("SELECT * FROM channels WHERE id = ?").get(id) as Row | undefined;
  return row ? toChannel(row) : null;
}

const MASK = "********";

function secretKeys(kind: string): Set<string> {
  return new Set(CHANNEL_KINDS.find((item) => item.kind === kind)?.fields.filter((field) => field.secret).map((field) => field.key) ?? []);
}

/** Secrets never go back to the page: it gets a mask, and saving the mask keeps the stored value. */
export function listChannels(): Array<Channel & { status: { ok: boolean; detail: string } }> {
  return allChannels().map((channel) => {
    const secrets = secretKeys(channel.kind);
    const config = Object.fromEntries(Object.entries(channel.config).map(([key, value]) => [key, secrets.has(key) && value ? MASK : value]));
    const adapter = adapters.get(adapterKey(channel.id));
    return { ...channel, config, status: !channel.enabled ? { ok: false, detail: "Disabled." } : (adapter?.status() ?? { ok: false, detail: "Not started." }) };
  });
}

/** The keys that name a bot: one bot listens in one place only, or two places would take each other's messages. */
const BOT_KEYS: Record<string, string[]> = { telegram: ["botToken"], slack: ["botToken", "appToken"] };

function refuseSharedBot(id: string, kind: string, config: Record<string, string>): void {
  const keys = (BOT_KEYS[kind] ?? []).filter((key) => config[key]);
  if (!keys.length) return;
  const here = currentProject();
  for (const project of allContexts()) {
    const clash = withProject(project, () => allChannels()).find(
      (channel) => channel.kind === kind && !(project.id === here.id && channel.id === id) && keys.some((key) => channel.config[key] === config[key]),
    );
    if (clash) {
      const where = isGlobal(project) ? "the global channels" : `the project ${project.name}`;
      throw new Error(`This bot is already the channel "${clash.name}" of ${where}. A bot can listen in one place only: give this one its own bot, or remove it there first.`);
    }
  }
}

export function saveChannel(input: { id?: string; kind: string; name: string; enabled?: boolean; config?: Record<string, string>; kinds?: string[] }): Channel & { status: { ok: boolean; detail: string } } {
  if (!CHANNEL_KINDS.some((item) => item.kind === input.kind)) throw new Error(`Unknown channel kind '${input.kind}'.`);
  const previous = input.id ? getChannel(input.id) : null;
  const config: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.config ?? {})) {
    config[key] = value === MASK ? (previous?.config[key] ?? "") : String(value ?? "").trim();
  }
  const id = input.id ?? nanoid(10);
  refuseSharedBot(id, input.kind, config);
  db.prepare(
    `INSERT INTO channels (id, kind, name, enabled, config, kinds, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, enabled = excluded.enabled, config = excluded.config, kinds = excluded.kinds`,
  ).run(id, input.kind, input.name.trim() || input.kind, input.enabled === false ? 0 : 1, JSON.stringify(config), JSON.stringify(input.kinds ?? INTERACTION_KINDS), now());
  restartChannel(id);
  broadcast("channels", {});
  return listChannels().find((item) => item.id === id)!;
}

export function deleteChannel(id: string): void {
  adapters.get(adapterKey(id))?.stop();
  adapters.delete(adapterKey(id));
  db.prepare("DELETE FROM channels WHERE id = ?").run(id);
  broadcast("channels", {});
}

function restartChannel(id: string): void {
  adapters.get(adapterKey(id))?.stop();
  adapters.delete(adapterKey(id));
  const channel = getChannel(id);
  if (!channel?.enabled) return;
  // Replies arrive from sockets and polls: each is handled in this channel's project.
  const onReply = bindProject((reply: InboundReply) => handleReply(id, reply));
  const project = currentProject();
  const adapter =
    channel.kind === "slack"
      ? createSlack(channel.config, onReply)
      : channel.kind === "device"
        ? createDevice(project.name, (sessionId, projectId) => `${dashboardUrl()}/#/${projectId ?? project.id}${sessionId ? `/session/${sessionId}` : ""}`)
        : channel.kind === "telegram"
          ? createTelegram(channel.config, onReply, { global: isGlobal(project) })
          : createHttp(channel.config, `${hubUrl()}/api/p/${project.id}/channels/${id}/reply`);
  adapters.set(adapterKey(id), adapter);
  adapter.start().then(
    bindProject(() => broadcast("channels", {})),
    (error) => console.error(`[channel ${channel.name}]`, (error as Error).message),
  );
  // Socket connections settle a moment after start() returns.
  setTimeout(bindProject(() => broadcast("channels", {})), 3000);
}

/** Starts the current project's channels. A project gets "this computer" from its first start; the global context does not. */
export function startChannels({ device = true }: { device?: boolean } = {}): void {
  // A project where it was switched off keeps its channel, disabled, so the choice is not undone here.
  if (device && !allChannels().some((channel) => channel.kind === "device")) {
    saveChannel({ kind: "device", name: "This computer", config: {}, kinds: ["permission", "question", "mcp"] });
  }
  for (const channel of allChannels()) if (channel.enabled) restartChannel(channel.id);
}

/** Stops the current project's channels. */
export function stopChannels(): void {
  const prefix = `${currentProject().id}:`;
  for (const [key, adapter] of adapters) {
    if (!key.startsWith(prefix)) continue;
    adapter.stop();
    adapters.delete(key);
  }
}

// Global: muted projects ------------------------------------------------------

/** The projects the global channels do not hear from, kept in the global context's settings. */
export function mutedProjects(): string[] {
  const global = globalContext();
  if (!global) return [];
  return withProject(global, () => {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'muted'").get() as { value: string } | undefined;
    return parseJson<string[]>(row?.value, []);
  });
}

export function setMuted(projectId: string, muted: boolean): string[] {
  const global = globalContext();
  if (!global) throw new Error("The hub's global context has not started.");
  const next = new Set(mutedProjects());
  if (muted) next.add(projectId);
  else next.delete(projectId);
  withProject(global, () => {
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('muted', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(
      JSON.stringify([...next]),
      now(),
    );
    broadcast("channels", {});
  });
  return [...next];
}

// Notifying ---------------------------------------------------------------------

function messageText(interaction: Interaction, session: string): string {
  const data = interaction.data;
  switch (interaction.kind) {
    case "permission":
      return renderPrompt("channel.permission", { session, tool: String(data.toolName ?? interaction.title), input: interaction.body });
    case "question": {
      const questions: Array<{ question: string; options?: Array<{ label: string; description?: string }> }> = data.questions ?? [];
      if (!questions.length) return renderPrompt("channel.question", { session, question: interaction.body, options: "" });
      return questions
        .map((question, index) =>
          renderPrompt("channel.question", {
            session: questions.length > 1 ? `${session} (${index + 1}/${questions.length})` : session,
            question: question.question,
            options: (question.options ?? []).map((option, n) => `${n + 1}. ${option.label}${option.description ? ` - ${option.description}` : ""}`).join("\n"),
          }),
        )
        .join("\n\n");
    }
    case "turn":
      return renderPrompt("channel.turn", { session, message: interaction.body });
    case "mcp":
      return renderPrompt("channel.mcp", { session, name: String(data.name ?? ""), reason: String(data.reason ?? ""), command: String(data.command ?? "") });
    case "done": {
      const deliverables = Object.entries((data.deliverables ?? {}) as Record<string, unknown>)
        .map(([key, value]) => `- ${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
        .join("\n");
      return renderPrompt("channel.done", { session, category: String(data.category ?? "-"), summary: String(data.summary ?? ""), deliverables });
    }
  }
}

/**
 * Sends an interaction to the current context's channels. `projectId` is set
 * when they are the global ones: it is the project the interaction is from,
 * kept with each message so a reply finds its way back there.
 */
async function deliver(interaction: Interaction, sessionTitle: string, projectId: string | null): Promise<void> {
  const text = messageText(interaction, sessionTitle);
  const presented = present(interaction, sessionTitle);
  for (const channel of allChannels()) {
    if (!channel.enabled || !channel.kinds.includes(interaction.kind)) continue;
    const adapter = adapters.get(adapterKey(channel.id));
    if (!adapter) continue;
    const thread = (db.prepare("SELECT thread FROM channel_threads WHERE channel_id = ? AND session_id = ?").get(channel.id, interaction.sessionId) as { thread: string } | undefined)?.thread ?? null;
    try {
      const sent = await adapter.send({
        sessionId: interaction.sessionId,
        interactionId: interaction.id,
        kind: interaction.kind,
        sessionTitle,
        text,
        options: interaction.options,
        presented,
        thread,
        projectId: projectId ?? undefined,
      });
      if (!sent) continue;
      db.prepare("INSERT OR REPLACE INTO channel_refs (channel_id, ref, session_id, interaction_id, project_id, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
        channel.id,
        sent.ref,
        interaction.sessionId,
        interaction.id,
        projectId,
        now(),
      );
      if (sent.thread && !thread) {
        db.prepare("INSERT OR REPLACE INTO channel_threads (channel_id, session_id, thread, project_id) VALUES (?, ?, ?, ?)").run(channel.id, interaction.sessionId, sent.thread, projectId);
        db.prepare("INSERT OR IGNORE INTO channel_refs (channel_id, ref, session_id, interaction_id, project_id, created_at) VALUES (?, ?, ?, NULL, ?, ?)").run(
          channel.id,
          sent.thread,
          interaction.sessionId,
          projectId,
          now(),
        );
      }
    } catch (error) {
      console.error(`[channel ${channel.name}] send failed:`, (error as Error).message);
    }
  }
}

/** The project's own channels, then the global ones unless this project is muted there. */
export async function notifyChannels(interaction: Interaction, sessionTitle: string): Promise<void> {
  await deliver(interaction, sessionTitle, null);
  broadcast("channels", {});
  const project = currentProject();
  const global = globalContext();
  if (!global || isGlobal(project) || mutedProjects().includes(project.id)) return;
  await withProject(global, async () => {
    await deliver(interaction, `${project.name} · ${sessionTitle}`, project.id);
    broadcast("channels", {});
  });
}

/** Tells every channel that carried an interaction how it ended, so nobody answers it twice: the project's, then the global ones. */
export async function acknowledgeOnChannels(interaction: Interaction, text: string | null): Promise<void> {
  if (!text) return;
  const follow = async () => {
    const refs = db.prepare("SELECT channel_id, ref FROM channel_refs WHERE interaction_id = ?").all(interaction.id) as Array<{ channel_id: string; ref: string }>;
    for (const { channel_id, ref } of refs) {
      const adapter = adapters.get(adapterKey(channel_id));
      if (!adapter) continue;
      const thread = (db.prepare("SELECT thread FROM channel_threads WHERE channel_id = ? AND session_id = ?").get(channel_id, interaction.sessionId) as { thread: string } | undefined)?.thread ?? null;
      await adapter.follow({ text, ref, thread }).catch(() => undefined);
    }
  };
  await follow();
  const global = globalContext();
  if (global && !isGlobal(currentProject())) await withProject(global, follow);
}

// Replies -----------------------------------------------------------------------

/** What a reply leads to through the message or thread it answers: a session, an interaction, and (on a global channel) a project. */
function lookupRefs(channelId: string, reply: InboundReply): { sessionId: string | null; interactionId: string | null; projectId: string | null } {
  let sessionId = reply.sessionId ?? null;
  let interactionId = reply.interactionId ?? null;
  let projectId: string | null = null;
  // A reply to a message answers what that message asked; a message in a session's thread is for the session, whatever is open in it now.
  for (const [key, exact] of [
    [reply.ref, true],
    [reply.thread, false],
  ] as const) {
    if (!key || sessionId) continue;
    const row = db.prepare("SELECT session_id, interaction_id, project_id FROM channel_refs WHERE channel_id = ? AND ref = ?").get(channelId, key) as
      | { session_id: string; interaction_id: string | null; project_id: string | null }
      | undefined;
    if (row) {
      sessionId = row.session_id;
      if (exact) interactionId ??= row.interaction_id;
      projectId = row.project_id;
    }
  }
  // A button on an interaction names only the interaction.
  if (interactionId && !projectId) {
    const row = db.prepare("SELECT project_id FROM channel_refs WHERE channel_id = ? AND interaction_id = ? AND project_id IS NOT NULL").get(channelId, interactionId) as
      | { project_id: string }
      | undefined;
    projectId = row?.project_id ?? null;
  }
  return { sessionId, interactionId, projectId };
}

async function handleReply(channelId: string, reply: InboundReply): Promise<ChannelAnswer> {
  if (isGlobal(currentProject())) return handleGlobalReply(channelId, reply);
  const { sessionId, interactionId } = lookupRefs(channelId, reply);
  return dispatch(channelId, reply, sessionId, interactionId, {});
}

/** A reply in the current project: to a session it leads to, or a command, a prompt asked for, the picked session. */
async function dispatch(channelId: string, reply: InboundReply, found: string | null, interactionId: string | null, options: CommandOptions): Promise<ChannelAnswer> {
  let sessionId = found;
  // A message that leads to no session is for the hub: a command, or the prompt a command asked for.
  // In a session's thread, or in reply to it, text is for the session ("/compact" included).
  const forHub = !sessionId && !interactionId && !reply.choice;
  try {
    // The session this person picked from /sessions (or started here), if any.
    const focus = forHub && !reply.command ? focusedSession(channelId, reply.from) : null;
    // A "/word" that is not the hub's own (/compact, /clear) goes to the picked session, as in its thread.
    const typed = forHub && isCommand(reply.text) && !(focus && !isHubCommand(reply.text));
    const command = reply.command ?? (typed ? reply.text : null);
    if (command) return await runCommand(channelId, command, reply.from, options);
    if (forHub && takesPrompt(channelId)) return answerPrompt(channelId, reply.text, reply.from, options);
    // A picked session that stopped is resumed with the message.
    if (focus) {
      if (!terminalForSession(focus)) return resumeWith(focus, reply.text);
      sessionId = focus;
    }
  } catch (error) {
    return (error as Error).message;
  }
  const { listInteractions, routeReply } = await import("../interactions.js");
  // Text with nowhere to go (nothing waits, no session picked): Claude guesses what was meant, as buttons.
  // Not on Slack, where a channel is full of people talking to each other, not to the bot.
  const slack = options.prefix ? options.prefix === "!" : getChannel(channelId)?.kind === "slack";
  if (forHub && !slack && !sessionId && !listInteractions({ status: "open" }).length && reply.text.trim()) {
    try {
      const guess = await interpret(channelId, reply.from, reply.text, options);
      if (guess) return guess;
    } catch (error) {
      console.error("[channel] could not interpret a message:", (error as Error).message);
    }
  }
  try {
    return await routeReply({ sessionId, interactionId, text: reply.text, by: reply.from, choice: reply.choice });
  } catch (error) {
    return (error as Error).message;
  }
}

// Global channels ---------------------------------------------------------------

/** The project each person on a global channel works on, from /use: <channel id>:<who>. */
const using = new Map<string, string>();

function projectChoices(): Project[] {
  return allContexts().filter((project) => !isGlobal(project));
}

function countsOf(project: Project): { running: number; waiting: number } {
  try {
    return withProject(project, () => {
      const sessions = listSessions();
      return { running: sessions.filter((session) => session.live).length, waiting: sessions.filter((session) => session.status === "waiting").length };
    });
  } catch {
    return { running: 0, waiting: 0 };
  }
}

function projectsCard(title: string, lines: string[] = []): ChannelCard {
  const projects = projectChoices();
  return {
    title,
    lines: projects.length
      ? [
          ...lines,
          ...projects.map((project, index) => {
            const { running, waiting } = countsOf(project);
            return `${index + 1}. ${project.name}${running ? ` · ▶️ ${running}` : ""}${waiting ? ` · ⏳ ${waiting}` : ""}`;
          }),
        ]
      : ["The hub has no projects yet: add one with the button below."],
    buttons: [...projects.slice(0, 15).map((project) => [{ label: `📁 ${project.name}`, command: `use ${project.id}` }]), [{ label: "➕ Add project", command: "addproject" }]],
  };
}

/** A card answered from inside a project, on a global channel: named after the project, and its buttons kept to it. */
function fromProject(answer: ChannelAnswer, project: Project): ChannelAnswer {
  if (!answer || typeof answer === "string") return answer;
  return {
    ...answer,
    title: `${answer.title} · ${project.name}`,
    buttons: answer.buttons?.map((row) =>
      row.map((button) => {
        const tagged = `@${project.id} ${button.command}`;
        // Telegram's callback data holds 64 bytes ("c|" included); a longer one falls back to the project picked with /use.
        return `c|${tagged}`.length <= 64 ? { ...button, command: tagged } : button;
      }),
    ),
  };
}

/** People on a global channel that /addproject asked for a folder: <channel id>:<who>. Their next plain message is the path. */
const askingPath = new Set<string>();

/** The card for the project someone now works on: what the other commands act on, and where to start. */
function workingOn(target: Project, prefix: string, title: string): ChannelAnswer {
  // fromProject adds the project's name to the title.
  return fromProject(
    {
      title,
      lines: [`${prefix}new, ${prefix}sessions, ${prefix}summary and the rest now act on ${target.name}. ${prefix}projects to switch.`],
      buttons: [
        [
          { label: "▶️ New session", command: "new", tone: "primary" },
          { label: "💬 Sessions", command: "sessions" },
        ],
        [{ label: "🗂 Queue", command: "queue" }],
      ],
    },
    target,
  );
}

/** The folders offered to someone by /addproject, for the button they press: <channel id>:<who>. */
const offered = new Map<string, string[]>();

/** Adds a folder of the hub's machine as a project, as Open folder does, and makes it the one this person works on. */
async function addPath(folder: string, key: string, prefix: string): Promise<ChannelAnswer> {
  // Imported when used: projects.ts starts the channels, so it cannot be a static import here.
  const { addProject } = await import("../projects.js");
  try {
    const info = addProject(folder);
    using.set(key, info.id);
    offered.delete(key);
    const target = contextById(info.id);
    return target ? workingOn(target, prefix, "➕ Added, working on") : `Added ${info.name}.`;
  } catch (error) {
    return `${(error as Error).message} ${prefix}addproject to look again.`;
  }
}

/**
 * /addproject with a path adds it; with words ("my calendar app"), the
 * project-looking folders on the machine that fit them come back as buttons
 * to pick from, since nobody knows a path by heart on a phone.
 */
async function addFromChannel(text: string, key: string, prefix: string): Promise<ChannelAnswer> {
  const request = text.trim().replace(/^["']|["']$/g, "");
  if (/^([a-zA-Z]:[\\/]|\/|~[\\/])/.test(request)) return addPath(request.replace(/^~/, (await import("node:os")).homedir()), key, prefix);
  const { findFolders } = await import("../folderFinder.js");
  const folders = await findFolders(request);
  if (!folders.length) {
    askingPath.add(key);
    return { title: "🔎 Nothing like that", lines: [renderPrompt("channel.noFolder", { request, p: prefix })], buttons: [[{ label: "Cancel", command: "cancel" }]] };
  }
  offered.set(key, folders.map((folder) => folder.path));
  return {
    title: "🔎 Which one?",
    lines: folders.map((folder, index) => `${index + 1}. ${folder.name} · ${folder.path}`),
    buttons: [
      ...folders.map((folder, index) => [{ label: `${index + 1}. ${folder.name}`, command: `addpick ${index + 1}` }]),
      [
        { label: "🔁 None of these", command: "addproject" },
        { label: "Cancel", command: "cancel" },
      ],
    ],
  };
}

/**
 * A message on a global channel. A reply to a project's message goes back
 * into that project; /projects and /use pick the project; anything else (a
 * command, a prompt asked for, text for the picked session) runs in the
 * project this person picked, as on that project's own channel.
 */
async function handleGlobalReply(channelId: string, reply: InboundReply): Promise<ChannelAnswer> {
  const global = currentProject();
  const prefix = (getChannel(channelId)?.kind ?? "") === "slack" ? "!" : "/";
  const found = lookupRefs(channelId, reply);
  if (found.projectId) {
    const target = contextById(found.projectId);
    if (!target) return "That project is no longer in the hub.";
    return withProject(target, () => dispatch(channelId, reply, found.sessionId, found.interactionId, {}));
  }

  // A card's button may name its project: "@<project id> <command>".
  const raw = (reply.command ?? reply.text).trim();
  const tagged = /^@(\S+)\s+([\s\S]+)$/.exec(raw);
  const body = tagged ? tagged[2] : raw;
  const isCommandText = Boolean(reply.command) || isCommand(body);
  const name = isCommandText ? /^[/!]?([a-z]+)/i.exec(body)?.[1]?.toLowerCase() : undefined;
  const key = `${channelId}:${reply.from}`;

  // The path /addproject asked for: the next plain message.
  if (askingPath.has(key) && !tagged && !isCommandText) {
    askingPath.delete(key);
    return addFromChannel(body, key, prefix);
  }
  if (name === "cancel" && !tagged && (askingPath.delete(key) || offered.delete(key))) return "Cancelled.";

  if (!tagged && name && ["projects", "use", "help", "start", "addproject", "add", "addpick"].includes(name)) {
    const arg = body.replace(/^[/!]?[a-z]+(@\S+)?\s*/i, "").trim();
    if (name === "addpick") {
      const folder = offered.get(key)?.[Number(arg) - 1];
      return folder ? addPath(folder, key, prefix) : `That list is gone. ${prefix}addproject to look again.`;
    }
    if (name === "addproject" || name === "add") {
      if (arg) return addFromChannel(arg, key, prefix);
      askingPath.add(key);
      return {
        title: "➕ Add a project",
        lines: [renderPrompt("channel.askPath", { p: prefix })],
        buttons: [[{ label: "Cancel", command: "cancel" }]],
      };
    }
    if (name === "use" && arg) {
      const projects = projectChoices();
      const target = projects.find((project) => project.id === arg.toLowerCase() || project.name.toLowerCase() === arg.toLowerCase()) ?? (/^\d+$/.test(arg) ? projects[Number(arg) - 1] : undefined);
      if (!target) {
        // A typo or a description ("the calendar one"): Claude matches it against the projects.
        const picked =
          (await pickNumbers(
            renderPrompt("typed.pickMatches", { request: arg, what: "projects", options: projects.map((project, index) => `${index + 1}. ${project.name} · ${project.root}`).join("\n") }),
          )) ?? [];
        const matches = picked.map((number) => projects[number - 1]).filter((project): project is Project => Boolean(project));
        if (!matches.length) return projectsCard("📁 Which project?", [`No project like '${arg}'.`]);
        return {
          title: "🤔 Which project did you mean?",
          buttons: [...matches.map((project) => [{ label: `📁 ${project.name}`, command: `use ${project.id}` }]), [{ label: "📁 All projects", command: "projects" }]],
        };
      }
      using.set(key, target.id);
      return workingOn(target, prefix, "📁 Working on");
    }
    if (name === "use" || name === "projects") return projectsCard("📁 Projects: pick one");
    const current = contextById(using.get(key) ?? "");
    return projectsCard(`Clauder Hub · every project`, [renderPrompt("channel.globalHelp", { p: prefix, current: current?.name ?? "none yet" }), ""]);
  }

  const projects = projectChoices();
  const targetId = tagged?.[1] ?? using.get(key) ?? (projects.length === 1 ? projects[0].id : null);
  const target = targetId ? contextById(targetId) : null;
  if (!target || isGlobal(target)) return projectsCard("📁 Pick a project first", [`Then send it again. ${prefix}use <project> works too.`]);

  const inner: InboundReply = tagged ? (reply.command ? { ...reply, command: body } : { ...reply, text: body }) : reply;
  // A session started from here is bound in the global context's database, with its project.
  const bind = (sessionId: string) => (sent: SentMessage) =>
    withProject(global, () => {
      const thread = sent.thread ?? sent.ref;
      for (const ref of new Set([sent.ref, thread])) {
        db.prepare("INSERT OR REPLACE INTO channel_refs (channel_id, ref, session_id, interaction_id, project_id, created_at) VALUES (?, ?, ?, NULL, ?, ?)").run(channelId, ref, sessionId, target.id, now());
      }
      db.prepare("INSERT OR REPLACE INTO channel_threads (channel_id, session_id, thread, project_id) VALUES (?, ?, ?, ?)").run(channelId, sessionId, thread, target.id);
    });
  const answer = await withProject(target, () => dispatch(channelId, inner, null, null, { prefix, bind }));
  return fromProject(answer, target);
}

/** For the http channel, whose replies arrive at the hub's own endpoint. */
export async function httpReply(channelId: string, secret: string | undefined, body: any): Promise<ChannelAnswer> {
  const channel = getChannel(channelId);
  if (!channel || channel.kind !== "http") throw new Error("No such webhook channel.");
  if (channel.config.secret && channel.config.secret !== secret) throw new Error("Wrong secret.");
  const choice = typeof body?.choice === "string" ? body.choice : undefined;
  // A command card's button, pressed in whatever the webhook drives: { command: "summary <session id>" }.
  if (typeof body?.command === "string" && body.command.trim()) return handleReply(channelId, { text: "", from: `http:${body.from ?? channel.name}`, command: body.command });
  if (!choice && (typeof body?.text !== "string" || !body.text.trim())) throw new Error("Send { text, interactionId?, sessionId? }, { choice, interactionId } or { command }.");
  if (choice && !body?.interactionId) throw new Error("A choice needs its interactionId.");
  return handleReply(channelId, {
    choice,
    text: body.text ?? "",
    from: `http:${body.from ?? channel.name}`,
    interactionId: body.interactionId,
    sessionId: body.sessionId,
  });
}

/** Sends a one-off message, for the dashboard's "test" button. */
export async function testChannel(id: string): Promise<void> {
  const adapter = adapters.get(adapterKey(id));
  if (!adapter) throw new Error("The channel is not running. Enable it and save first.");
  await adapter.send({
    sessionId: "test",
    interactionId: `test-${nanoid(6)}`,
    kind: "test",
    sessionTitle: "Clauder Hub",
    text: "Clauder Hub: this channel is connected.",
    options: [],
    thread: null,
  });
}
