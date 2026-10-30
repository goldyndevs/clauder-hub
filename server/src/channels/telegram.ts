import { COMMAND_MENU, GLOBAL_COMMAND_MENU } from "./commands.js";
import { KIND_LABEL, truncate } from "./format.js";
import { toTelegramHtml } from "./markdown.js";
import type { ChannelAdapter, ChannelAnswer, ChannelKindInfo, OutboundMessage, ReplyHandler, SentMessage } from "./types.js";

/**
 * Telegram through the Bot API with long polling, so nothing has to be
 * reachable from the internet. Replying to a message the bot sent routes the
 * answer to that session; a plain message goes to whatever single thing is
 * waiting.
 */
export const telegramInfo: ChannelKindInfo = {
  kind: "telegram",
  label: "Telegram",
  twoWay: true,
  fields: [
    { key: "botToken", label: "Bot token", secret: true, placeholder: "123456:ABC-...", hint: "From @BotFather." },
    { key: "chatId", label: "Chat ID", placeholder: "123456789", hint: "Message the bot once, then open https://api.telegram.org/bot<token>/getUpdates to find it." },
  ],
};

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The presented message in Telegram's HTML: the session and kind, the headline
 * in bold, a short excerpt of the details, and the choices as inline buttons,
 * two to a row, each carrying "<interaction id>|<choice ref>" (well under the
 * 64 bytes Telegram allows).
 */
function htmlFor(message: OutboundMessage): Record<string, unknown> | null {
  const presented = message.presented;
  if (!presented) return null;
  const lines = [`<i>${escape(presented.sessionTitle)} · ${KIND_LABEL[presented.kind] ?? presented.kind}</i>`, `<b>${escape(presented.headline)}</b>`];
  if (presented.question) lines.push(escape(presented.question));
  if (presented.questions && presented.questions.length > 1) {
    for (const [index, question] of presented.questions.entries()) {
      lines.push("", `<b>${index + 1}. ${escape(question.question)}</b>`, ...question.options.map((option, n) => `   ${n + 1}) ${escape(option.label)}`));
    }
    lines.push("", "<i>Reply with one number per question, e.g. 1,2.</i>");
  } else {
    for (const choice of presented.choices.filter((item) => item.description)) lines.push(`• <b>${escape(choice.label)}</b>: ${escape(choice.description ?? "")}`);
  }
  // On a phone: the key lines first, the whole message folded underneath (Telegram shows a few lines and "show more").
  if (presented.gist?.length) lines.push("", ...presented.gist.map(escape));
  if (presented.answerable && presented.freeText) lines.push("<i>Or reply to this message in your own words.</i>");
  if (presented.details) {
    // Cut before converting, so the cut never lands inside a tag; what is left of Telegram's 4096 goes to it.
    const room = Math.max(500, 3300 - lines.join("\n").length);
    lines.push(
      presented.details.format === "code"
        ? `<pre>${escape(truncate(presented.details.text, Math.min(room, 1500)))}</pre>`
        : `<blockquote expandable>${toTelegramHtml(truncate(presented.details.text, room), { inQuote: true })}</blockquote>`,
    );
  }
  const buttons = presented.answerable
    ? [...presented.choices, ...presented.quickReplies].map((choice) => ({ text: truncate(choice.label, 60), callback_data: `${message.interactionId}|${choice.ref}` }))
    : [];
  const rows: Array<typeof buttons> = [];
  for (let index = 0; index < buttons.length; index += 2) rows.push(buttons.slice(index, index + 2));
  return {
    text: lines.join("\n"),
    parse_mode: "HTML",
    ...(rows.length ? { reply_markup: { inline_keyboard: rows } } : {}),
  };
}

/** A command's answer: a card in HTML with its buttons, each carrying "c|<command>"; plain text as it is. */
function answerBody(answer: Exclude<ChannelAnswer, null>): Record<string, unknown> {
  if (typeof answer === "string") return { text: truncate(answer, 4000) };
  const lines = [`<b>${escape(answer.title)}</b>`, ...(answer.lines ?? []).map(escape)];
  if (answer.quote) lines.push(`<blockquote expandable>${toTelegramHtml(truncate(answer.quote, Math.max(500, 3300 - lines.join("\n").length)), { inQuote: true })}</blockquote>`);
  const rows = (answer.buttons ?? []).map((row) => row.map((button) => ({ text: truncate(button.label, 60), callback_data: `c|${button.command}`.slice(0, 64) })));
  return { text: lines.join("\n"), parse_mode: "HTML", reply_markup: { inline_keyboard: rows } };
}

interface TelegramConfig {
  botToken?: string;
  chatId?: string;
}

export function createTelegram(config: TelegramConfig, onReply: ReplyHandler, { global = false }: { global?: boolean } = {}): ChannelAdapter {
  let stopped = false;
  let offset = 0;
  let state = { ok: false, detail: "Not connected yet." };
  let abort: AbortController | null = null;

  const call = async (method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<any> => {
    const response = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    const payload = (await response.json()) as any;
    if (!payload.ok) throw new Error(`Telegram ${method}: ${payload.description ?? response.status}`);
    return payload.result;
  };

  /** Sends a command's answer; a card that started something learns where it landed, so replies to it are routed. */
  const sendAnswer = async (answer: Exclude<ChannelAnswer, null>, replyTo?: number) => {
    const where = replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {};
    const sent = await call("sendMessage", { chat_id: config.chatId, ...answerBody(answer), ...where });
    if (typeof answer !== "string") answer.onSent?.({ ref: String(sent.message_id), thread: String(sent.message_id) });
  };

  /** A command button: the menu it sits in turns into the answer, as BotFather's do; what starts a session comes as a new message. */
  const onCommandButton = async (query: any, command: string) => {
    const message = query.message;
    const answer = await onReply({ text: "", from: `telegram:${query.from?.username ?? query.from?.id}`, command });
    await call("answerCallbackQuery", { callback_query_id: query.id }).catch(() => undefined);
    if (!answer) return;
    if (typeof answer !== "string" && answer.onSent) return void (await sendAnswer(answer, message.message_id).catch(() => undefined));
    await call("editMessageText", { chat_id: config.chatId, message_id: message.message_id, ...answerBody(answer) }).catch((error: Error) =>
      // Pressing a button whose answer is what the card already shows is not a failure: nothing to post again.
      /not modified/i.test(error.message) ? undefined : sendAnswer(answer).catch(() => undefined),
    );
  };

  /** A tap on an inline button: answered through the hub, then the buttons come off and the answer is noted. */
  const onButton = async (query: any) => {
    const message = query.message;
    if (String(message?.chat?.id) !== String(config.chatId)) return;
    const data = String(query.data ?? "");
    if (data.startsWith("c|")) return onCommandButton(query, data.slice(2));
    const [interactionId, choice] = data.split("|");
    const button = (message?.reply_markup?.inline_keyboard ?? []).flat().find((item: any) => item.callback_data === query.data);
    const answer = interactionId && choice ? await onReply({ text: "", from: `telegram:${query.from?.username ?? query.from?.id}`, interactionId, choice }) : null;
    const result = typeof answer === "string" ? answer : null;
    // Telegram keeps the button spinning until the tap is acknowledged.
    await call("answerCallbackQuery", { callback_query_id: query.id, text: result ?? "" }).catch(() => undefined);
    await call("editMessageReplyMarkup", { chat_id: config.chatId, message_id: message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
    const who = query.from?.username ? `@${query.from.username}` : (query.from?.first_name ?? "someone");
    await call("sendMessage", {
      chat_id: config.chatId,
      text: `${who}: ${button?.text ?? choice}${result && !result.startsWith("Sent") ? ` (${result})` : ""}`,
      reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
    }).catch(() => undefined);
  };

  const poll = async () => {
    while (!stopped) {
      try {
        abort = new AbortController();
        const updates: any[] = await call("getUpdates", { offset, timeout: 30, allowed_updates: ["message", "callback_query"] }, abort.signal);
        state = { ok: true, detail: "Polling." };
        for (const update of updates) {
          offset = update.update_id + 1;
          if (update.callback_query) {
            await onButton(update.callback_query);
            continue;
          }
          const message = update.message;
          if (!message?.text || String(message.chat?.id) !== String(config.chatId)) continue;
          const replyTo = message.reply_to_message?.message_id;
          const answer = await onReply({
            text: message.text,
            from: `telegram:${message.from?.username ?? message.from?.id}`,
            ref: replyTo ? String(replyTo) : undefined,
          });
          if (answer) await sendAnswer(answer, message.message_id).catch(() => undefined);
        }
      } catch (error) {
        if (stopped) return;
        state = { ok: false, detail: (error as Error).message };
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  };

  return {
    async start() {
      if (!config.botToken || !config.chatId) {
        state = { ok: false, detail: "Bot token and chat ID are both needed." };
        return;
      }
      // The menu Telegram shows when "/" is typed in this chat, as BotFather has.
      void call("setMyCommands", { commands: global ? GLOBAL_COMMAND_MENU : COMMAND_MENU, scope: { type: "chat", chat_id: config.chatId } }).catch(() => undefined);
      void poll();
    },
    stop() {
      stopped = true;
      abort?.abort();
    },
    async send(message: OutboundMessage): Promise<SentMessage | null> {
      if (!config.botToken || !config.chatId) return null;
      const rich = htmlFor(message);
      const where = message.thread ? { reply_parameters: { message_id: Number(message.thread), allow_sending_without_reply: true } } : {};
      // HTML Telegram cannot parse fails the whole message, so the plain text is the fallback.
      const sent = await (rich ? call("sendMessage", { chat_id: config.chatId, ...rich, ...where }) : Promise.reject(new Error("plain")))
        .catch(() => call("sendMessage", { chat_id: config.chatId, text: truncate(message.text, 4000), ...where }));
      return { ref: String(sent.message_id), thread: message.thread ?? String(sent.message_id) };
    },
    async follow({ text, ref }) {
      if (!config.botToken || !config.chatId) return;
      await call("sendMessage", { chat_id: config.chatId, text, reply_parameters: { message_id: Number(ref), allow_sending_without_reply: true } });
    },
    status: () => state,
  };
}
