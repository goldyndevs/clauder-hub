import type { Presented } from "../presentation.js";
import { KIND_LABEL, truncate } from "./format.js";
import type { ChannelAdapter, ChannelKindInfo, OutboundMessage, SentMessage } from "./types.js";

/**
 * Anything that takes a webhook: n8n, Make, Power Automate, Teams Workflows,
 * Discord, Google Chat. Replies come back by POSTing to the hub's reply URL,
 * which the full JSON payload carries; formats for chat webhooks are one-way.
 */
export const httpInfo: ChannelKindInfo = {
  kind: "http",
  label: "Webhook (Teams, Discord, n8n, ...)",
  twoWay: true,
  fields: [
    { key: "url", label: "Webhook URL", placeholder: "https://..." },
    {
      key: "format",
      label: "Payload format",
      options: ["json", "text", "discord", "teams"],
      hint: "json: everything, including replyUrl (two-way). text: {text} (Slack/Google Chat webhooks). discord: {content}. teams: an Adaptive Card for a Teams Workflows webhook.",
    },
    { key: "headers", label: "Extra headers (JSON)", placeholder: '{"Authorization":"Bearer ..."}', secret: true },
    { key: "secret", label: "Reply secret", secret: true, hint: "Replies must send it as the x-clauder-secret header." },
  ],
};

interface HttpConfig {
  url?: string;
  format?: string;
  headers?: string;
  secret?: string;
}

export function createHttp(config: HttpConfig, replyUrl: string): ChannelAdapter {
  let state = { ok: Boolean(config.url), detail: config.url ? "Ready." : "No URL set." };

  const post = async (body: unknown) => {
    let headers: Record<string, string> = {};
    try {
      headers = config.headers ? JSON.parse(config.headers) : {};
    } catch {
      throw new Error("Extra headers are not valid JSON.");
    }
    const response = await fetch(config.url!, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    state = response.ok ? { ok: true, detail: `Last delivery: ${response.status}.` } : { ok: false, detail: `Last delivery failed: ${response.status}.` };
    if (!response.ok) throw new Error(`Webhook answered ${response.status}.`);
  };

  /**
   * Chat webhooks cannot carry buttons back to the hub, so Teams and Discord
   * get the presented message laid out to read at a glance, with the choices
   * listed; they are answered from the dashboard or another channel. The json
   * format carries everything, including how to answer with a choice.
   */
  const shape = (text: string, extra: Record<string, unknown>, presented?: Presented) => {
    switch (config.format) {
      case "text":
        return { text };
      case "discord":
        if (!presented) return { content: truncate(text, 2000) };
        return {
          embeds: [
            {
              author: { name: truncate(`${presented.sessionTitle} · ${KIND_LABEL[presented.kind] ?? presented.kind}`, 250) },
              title: truncate(presented.headline, 250),
              description: truncate([presented.question, presented.details ? (presented.details.format === "code" ? `\`\`\`\n${truncate(presented.details.text, 1500)}\n\`\`\`` : truncate(presented.details.text, 1500)) : ""].filter(Boolean).join("\n\n"), 4000),
              fields: presented.answerable ? [...presented.choices, ...presented.quickReplies].slice(0, 25).map((choice) => ({ name: truncate(choice.label, 250), value: truncate(choice.description ?? "​", 1000), inline: !choice.description })) : [],
              color: presented.kind === "done" ? 0x2f9e5b : 0xd97757,
            },
          ],
        };
      case "teams": {
        const body: unknown[] = presented
          ? [
              { type: "TextBlock", text: `${presented.sessionTitle} · ${KIND_LABEL[presented.kind] ?? presented.kind}`, isSubtle: true, size: "Small", wrap: true },
              { type: "TextBlock", text: presented.headline, weight: "Bolder", size: "Medium", wrap: true },
              ...(presented.question ? [{ type: "TextBlock", text: presented.question, wrap: true }] : []),
              ...(presented.answerable && presented.choices.length
                ? [{ type: "FactSet", facts: presented.choices.map((choice, index) => ({ title: `${index + 1}. ${choice.label}`, value: choice.description ?? "" })) }]
                : []),
              ...(presented.details ? [{ type: "TextBlock", text: truncate(presented.details.text, 1500), wrap: true, fontType: presented.details.format === "code" ? "Monospace" : "Default", isSubtle: true }] : []),
              ...(presented.answerable ? [{ type: "TextBlock", text: "Answer from the Clauder Hub inbox or another channel.", isSubtle: true, size: "Small", wrap: true }] : []),
            ]
          : [{ type: "TextBlock", text, wrap: true }];
        return {
          type: "message",
          attachments: [
            {
              contentType: "application/vnd.microsoft.card.adaptive",
              content: { type: "AdaptiveCard", $schema: "http://adaptivecards.io/schemas/adaptive-card.json", version: "1.4", body },
            },
          ],
        };
      }
      default:
        return { text, ...extra, ...(presented ? { presented } : {}) };
    }
  };

  return {
    async start() {},
    stop() {},
    async send(message: OutboundMessage): Promise<SentMessage | null> {
      if (!config.url) return null;
      await post(
        shape(
          message.text,
          {
            sessionId: message.sessionId,
            sessionTitle: message.sessionTitle,
            interactionId: message.interactionId,
            kind: message.kind,
            options: message.options,
            replyUrl,
            howToChoose: "POST { interactionId, choice } with a ref from presented.choices or presented.quickReplies",
          },
          message.presented,
        ),
      );
      return { ref: message.interactionId };
    },
    async follow({ text, ref }) {
      if (!config.url) return;
      await post(shape(text, { interactionId: ref, kind: "follow-up" }));
    },
    status: () => state,
  };
}
