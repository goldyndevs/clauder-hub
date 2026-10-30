/**
 * A channel is somewhere a person can be reached: Slack, Telegram, a webhook.
 * Each adapter does two things, and nothing about sessions: send a message
 * (optionally into a thread), and report replies. The hub decides what a reply
 * means.
 */
import type { Presented } from "../presentation.js";

export interface OutboundMessage {
  sessionId: string;
  interactionId: string;
  kind: string;
  sessionTitle: string;
  text: string;
  options: Array<{ key: string; label: string }>;
  /** The same message, structured: what rich channels draw, with buttons where they can. Absent on a test message. */
  presented?: Presented;
  /** The thread this session already has on the channel, if any. */
  thread: string | null;
  /** On a global channel, the project the session is in. */
  projectId?: string;
}

export interface SentMessage {
  /** Identifies this message, so a reply to it can be traced back. */
  ref: string;
  /** The session's thread, when this message started one. */
  thread?: string;
}

export interface InboundReply {
  text: string;
  from: string;
  /** The message replied to, if the platform says. */
  ref?: string;
  /** The thread the reply was posted in, if any. */
  thread?: string;
  /** A button press: a Presented choice ref ("o:1", "q:0"), with interactionId set. */
  choice?: string;
  /** A command button's press ("summary <session id>"), from a card the hub sent. */
  command?: string;
  /** Some adapters (http) are told outright. */
  interactionId?: string;
  sessionId?: string;
}

export interface ChannelAdapter {
  start(): Promise<void>;
  stop(): void;
  send(message: OutboundMessage): Promise<SentMessage | null>;
  /** A short follow-up in the same place, e.g. "answered by X". */
  follow(message: { text: string; ref: string; thread: string | null }): Promise<void>;
  status(): { ok: boolean; detail: string };
}

/**
 * What a command answers with, drawn by each platform its own way: a title in
 * bold, plain lines, an optional quote, and buttons that run another command
 * when pressed, as BotFather's menus do.
 */
export interface ChannelCard {
  title: string;
  lines?: string[];
  quote?: string;
  /** Rows of buttons; each runs `command` ("summary <session id>") when pressed. */
  buttons?: Array<Array<{ label: string; command: string; tone?: "primary" | "danger" }>>;
  /** Told where the card landed, so a reply to it can find its session. */
  onSent?: (sent: SentMessage) => void;
}

export type ChannelAnswer = string | ChannelCard | null;

export type ReplyHandler = (reply: InboundReply) => Promise<ChannelAnswer>;

export interface ChannelKindInfo {
  kind: string;
  label: string;
  /** Whether replies come back on their own, without the dashboard. */
  twoWay: boolean;
  fields: Array<{ key: string; label: string; secret?: boolean; placeholder?: string; hint?: string; options?: string[] }>;
}
