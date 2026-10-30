import WebSocket from "ws";
import { KIND_LABEL, truncate } from "./format.js";
import { toSlackMrkdwn } from "./markdown.js";
import type { ChannelAdapter, ChannelAnswer, ChannelKindInfo, OutboundMessage, ReplyHandler, SentMessage } from "./types.js";

/**
 * Slack over Socket Mode: the hub opens the connection outwards, so nothing
 * has to be reachable from the internet. Each session gets one thread in the
 * configured channel, and a reply in that thread goes back to the session.
 *
 * The Slack app needs Socket Mode on (an app-level token with
 * connections:write), the bot scopes chat:write and channels:history (or
 * groups:history for a private channel), the message.channels or
 * message.groups event, and the bot invited into the channel. For the
 * buttons, Interactivity must be switched on; with Socket Mode it needs no
 * request URL, the clicks arrive over the same connection.
 */
export const slackInfo: ChannelKindInfo = {
  kind: "slack",
  label: "Slack",
  twoWay: true,
  fields: [
    { key: "botToken", label: "Bot token", secret: true, placeholder: "xoxb-...", hint: "OAuth & Permissions. Scopes: chat:write, channels:history (groups:history for private)." },
    { key: "appToken", label: "App-level token", secret: true, placeholder: "xapp-...", hint: "Basic Information > App-Level Tokens, scope connections:write. Turn on Socket Mode, and Interactivity for the buttons." },
    { key: "channel", label: "Channel ID", placeholder: "C0123456789", hint: "Channel details > About. Invite the bot into it." },
  ],
};

/** Slack's mrkdwn treats these three as markup. */
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const FENCE = "```";

/**
 * The presented message as Block Kit: who and what in a context line, the
 * headline in bold, details folded to a short excerpt, and every choice and
 * quick reply as a button whose value is "<interaction id>|<choice ref>".
 */
function blocksFor(message: OutboundMessage): unknown[] | undefined {
  const presented = message.presented;
  if (!presented) return undefined;
  const blocks: unknown[] = [
    { type: "context", elements: [{ type: "mrkdwn", text: `*${escape(presented.sessionTitle)}* · ${KIND_LABEL[presented.kind] ?? presented.kind}` }] },
    { type: "section", text: { type: "mrkdwn", text: `*${escape(presented.headline)}*${presented.question ? `\n${escape(presented.question)}` : ""}` } },
  ];
  // Several questions at once are answered by typing their numbers, so they are listed rather than buttoned.
  if (presented.questions && presented.questions.length > 1) {
    const listed = presented.questions
      .map((question, index) => `*${index + 1}. ${escape(question.question)}*\n${question.options.map((option, n) => `   ${n + 1}) ${escape(option.label)}`).join("\n")}`)
      .join("\n");
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `${truncate(listed, 2850)}\n_Reply with one number per question, e.g. 1,2._` } });
  } else {
    const described = presented.choices.filter((choice) => choice.description);
    if (described.length) {
      const lines = described.map((choice) => `*${escape(choice.label)}*: ${escape(choice.description ?? "")}`).join("\n");
      // A context element holds at most 2000 characters.
      blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: truncate(lines, 1950) }] });
    }
  }
  // On a phone: the key lines first, then the whole message, which Slack folds behind "See more" when long.
  if (presented.gist?.length) blocks.push({ type: "section", text: { type: "mrkdwn", text: escape(presented.gist.join("\n")) } });
  if (presented.details) {
    const text =
      presented.details.format === "code"
        ? `${FENCE}\n${escape(truncate(presented.details.text, 1200))}\n${FENCE}`
        : truncate(toSlackMrkdwn(truncate(presented.details.text, 2400)), 2900);
    blocks.push(...(presented.details.format === "code" ? [] : [{ type: "divider" }]), { type: "section", text: { type: "mrkdwn", text } });
  }
  const buttons = [...presented.choices, ...presented.quickReplies].map((choice) => ({
    type: "button",
    text: { type: "plain_text", text: truncate(choice.label, 75) },
    value: `${message.interactionId}|${choice.ref}`,
    action_id: `clauder_${choice.ref}`,
    ...(choice.tone === "primary" ? { style: "primary" } : choice.tone === "danger" ? { style: "danger" } : {}),
  }));
  if (presented.answerable && buttons.length) blocks.push({ type: "actions", elements: buttons.slice(0, 25) });
  if (presented.answerable && presented.freeText) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: "Or reply in this thread in your own words." }] });
  return blocks;
}

/**
 * What a person typed, as they typed it: Slack sends &amp; &lt; &gt; as entities and
 * wraps links as <https://x|x>, which Claude should not be handed.
 */
function fromSlack(text: string): string {
  return text
    .replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, (_whole, url: string, label: string) => (label === url || url.endsWith(label) ? url : `${label} (${url})`))
    .replace(/<((?:https?|mailto):[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** A command's answer as Block Kit: the card's title and lines, its quote, and its buttons, each valued "c|<command>". */
function answerBlocks(answer: Exclude<ChannelAnswer, null>): { text: string; blocks?: unknown[] } {
  // Blocks even for plain text: chat.update without them would keep the old card and its buttons.
  if (typeof answer === "string") return { text: answer, blocks: [{ type: "section", text: { type: "mrkdwn", text: escape(truncate(answer, 2900)) } }] };
  const blocks: unknown[] = [{ type: "section", text: { type: "mrkdwn", text: truncate([`*${escape(answer.title)}*`, ...(answer.lines ?? []).map(escape)].join("\n"), 2900) } }];
  if (answer.quote) blocks.push({ type: "divider" }, { type: "section", text: { type: "mrkdwn", text: truncate(toSlackMrkdwn(truncate(answer.quote, 2400)), 2900) } });
  for (const [index, row] of (answer.buttons ?? []).entries()) {
    blocks.push({
      type: "actions",
      elements: row.map((button, n) => ({
        type: "button",
        text: { type: "plain_text", text: truncate(button.label, 75) },
        value: `c|${button.command}`,
        action_id: `clauder_cmd_${index}_${n}`,
        ...(button.tone === "primary" ? { style: "primary" } : button.tone === "danger" ? { style: "danger" } : {}),
      })),
    });
  }
  return { text: answer.title, blocks };
}

interface SlackConfig {
  botToken?: string;
  appToken?: string;
  channel?: string;
}

async function slackApi(method: string, token: string, body: Record<string, unknown>): Promise<any> {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as any;
  if (!payload.ok) throw new Error(`Slack ${method}: ${payload.error ?? response.status}`);
  return payload;
}

export function createSlack(config: SlackConfig, onReply: ReplyHandler): ChannelAdapter {
  let socket: WebSocket | null = null;
  let stopped = false;
  let state = { ok: false, detail: "Not connected yet." };
  let retry = 0;

  /** Posts a command's answer in a thread; a card that started something learns where, so the thread leads to it. */
  const postAnswer = async (answer: Exclude<ChannelAnswer, null>, thread: string) => {
    if (!config.botToken) return;
    // A card that starts a session goes to the channel itself, so the session gets a thread of its own.
    const own = typeof answer !== "string" && Boolean(answer.onSent);
    const posted = await slackApi("chat.postMessage", config.botToken, { channel: config.channel, ...(own ? {} : { thread_ts: thread }), ...answerBlocks(answer) });
    if (typeof answer !== "string") answer.onSent?.({ ref: String(posted.ts), thread: own ? String(posted.ts) : thread });
  };

  /** A command button: the card it sits on turns into the answer, as BotFather's menus do; what starts a session is posted anew. */
  const onCommandButton = async (payload: any, command: string) => {
    const message = payload.message ?? {};
    const answer = await onReply({ text: "", from: `slack:${payload.user?.id}`, command });
    if (!answer || !config.botToken) return;
    const thread = message.thread_ts ?? message.ts;
    if (typeof answer !== "string" && answer.onSent) return void (await postAnswer(answer, thread).catch(() => undefined));
    await slackApi("chat.update", config.botToken, { channel: payload.channel?.id ?? config.channel, ts: message.ts, ...answerBlocks(answer) }).catch(() =>
      postAnswer(answer, thread).catch(() => undefined),
    );
  };

  /** A button click: answered through the hub, then the buttons come off and the answer is noted in their place. */
  const onButton = async (payload: any) => {
    const action = payload?.type === "block_actions" ? payload.actions?.[0] : null;
    const value = String(action?.value ?? "");
    if (value.startsWith("c|")) return onCommandButton(payload, value.slice(2));
    const [interactionId, choice] = value.split("|");
    if (!interactionId || !choice || !config.botToken) return;
    const message = payload.message ?? {};
    const answer = await onReply({ text: "", from: `slack:${payload.user?.id}`, interactionId, choice, thread: message.thread_ts ?? message.ts });
    const result = typeof answer === "string" ? answer : null;
    const blocks = (Array.isArray(message.blocks) ? message.blocks : []).filter((block: any) => block.type !== "actions");
    const note = result && !result.startsWith("Sent") ? ` (${escape(result)})` : "";
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `<@${payload.user?.id}>: ${escape(action.text?.text ?? choice)}${note}` }] });
    await slackApi("chat.update", config.botToken, { channel: payload.channel?.id ?? config.channel, ts: message.ts, blocks, text: message.text ?? "" }).catch(() => undefined);
  };

  const connect = async () => {
    if (stopped) return;
    if (!config.botToken || !config.appToken || !config.channel) {
      state = { ok: false, detail: "Bot token, app token and channel are all needed." };
      return;
    }
    try {
      const { url } = await slackApi("apps.connections.open", config.appToken, {});
      socket = new WebSocket(url);
      socket.on("open", () => {
        retry = 0;
        state = { ok: true, detail: "Connected (Socket Mode)." };
      });
      socket.on("message", (raw) => {
        let envelope: any;
        try {
          envelope = JSON.parse(String(raw));
        } catch {
          return;
        }
        // Every envelope must be acknowledged within 3 seconds or Slack retries it.
        if (envelope.envelope_id) socket?.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
        if (envelope.type === "disconnect") socket?.close();
        if (envelope.type === "interactive") return void onButton(envelope.payload);
        const event = envelope.payload?.event;
        if (envelope.type !== "events_api" || event?.type !== "message") return;
        // Our own posts, edits and joins all arrive here too.
        if (event.bot_id || event.subtype || event.channel !== config.channel || !event.text) return;
        void onReply({ text: fromSlack(event.text), from: `slack:${event.user}`, thread: event.thread_ts, ref: event.thread_ts }).then((answer) => {
          if (answer) void postAnswer(answer, event.thread_ts ?? event.ts).catch(() => undefined);
        });
      });
      socket.on("close", () => {
        socket = null;
        if (stopped) return;
        state = { ok: false, detail: "Disconnected, reconnecting..." };
        retry += 1;
        setTimeout(() => void connect(), Math.min(30_000, 1000 * 2 ** retry));
      });
      socket.on("error", (error) => {
        state = { ok: false, detail: error.message };
      });
    } catch (error) {
      state = { ok: false, detail: (error as Error).message };
      retry += 1;
      if (!stopped) setTimeout(() => void connect(), Math.min(60_000, 2000 * 2 ** retry));
    }
  };

  return {
    async start() {
      await connect();
    },
    stop() {
      stopped = true;
      socket?.close();
    },
    async send(message: OutboundMessage): Promise<SentMessage | null> {
      if (!config.botToken || !config.channel) return null;
      const blocks = blocksFor(message);
      const post = (withBlocks: boolean) =>
        slackApi("chat.postMessage", config.botToken!, {
          channel: config.channel,
          // The plain text stays as the notification, and the fallback for clients without blocks.
          text: truncate(message.text, 3900),
          ...(withBlocks && blocks ? { blocks } : {}),
          ...(message.thread ? { thread_ts: message.thread } : {}),
        });
      // Blocks Slack refuses (a limit missed) must not lose the message: it goes again as plain text.
      const posted = await post(true).catch(() => post(false));
      // The first message about a session starts its thread.
      return { ref: String(posted.ts), thread: message.thread ?? String(posted.ts) };
    },
    async follow({ text, thread, ref }) {
      if (!config.botToken || !config.channel) return;
      await slackApi("chat.postMessage", config.botToken, { channel: config.channel, thread_ts: thread ?? ref, text });
    },
    status: () => state,
  };
}
