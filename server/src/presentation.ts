import { gistOf } from "./channels/markdown.js";
import type { Interaction } from "./interactions.js";

/**
 * One interaction, as a person should see it: a one-line headline, the
 * question, the choices as buttons, a few quick replies, and the raw text
 * folded away as details. The dashboard's inbox and every channel draw from
 * this same shape, so they read alike; the raw text stays on the interaction.
 *
 * A button carries a reference ("o:2" for an option, "q:0" for a quick reply)
 * rather than its answer, so it fits Telegram's 64-byte callback data, and the
 * hub turns it back into the answer with resolveChoice().
 */
export interface Choice {
  ref: string;
  label: string;
  description?: string;
  tone?: "primary" | "danger";
}

export interface PresentedQuestion {
  header?: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
}

export interface Presented {
  kind: Interaction["kind"];
  sessionTitle: string;
  headline: string;
  question?: string;
  /** AskUserQuestion can ask several at once; each is answered by option number. */
  questions?: PresentedQuestion[];
  choices: Choice[];
  quickReplies: Choice[];
  /** Whether a typed answer makes sense, and what to call it. */
  freeText: string | null;
  details?: { label: string; text: string; format: "code" | "markdown" };
  /** A long message's few key lines, for reading on a phone; the details hold the whole of it. */
  gist?: string[];
  answerable: boolean;
}

const oneLine = (text: string, max = 160) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}...` : flat;
};

/** Markdown markers that read as noise once the text is on one line. */
const plain = (text: string) =>
  text
    .replace(/`{3}[\s\S]*?`{3}/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    // Markers only: user_id, C#, #123 and a > b stay as written.
    .replace(/^\s*(#+|>)\s?/gm, "")
    .replace(/`+|\*\*|~~/g, "")
    .replace(/(^|[\s(])(__|_|\*)([^_*\n]+?)\2(?=[\s),:;!?]|\.(?!\w)|$)/gm, "$1$3")
    .trim();

/**
 * What Claude is actually asking at the end of a turn: the last sentence that
 * is a question, in the last paragraph that says anything; failing that, the
 * start of that paragraph.
 */
export function mainQuestion(message: string): { headline: string; isQuestion: boolean } {
  const paragraphs = plain(message)
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  // A sentence ends at . ? ! followed by a space or the end, so file names and paths stay whole.
  const sentencesOf = (part: string) =>
    part
      .split(/(?<=[.?!])\s+|\n+/)
      .map((sentence) => sentence.trim())
      .filter(Boolean);
  const last = paragraphs[paragraphs.length - 1] ?? "";
  const sentences = sentencesOf(last);
  const first = sentences.findIndex((sentence) => sentence.endsWith("?"));
  if (first !== -1) {
    // "Should I update the tests? Or leave them?" reads as one question; keep the run when it fits.
    const run = sentences.slice(first).join(" ");
    const lastQuestion = [...sentences].reverse().find((sentence) => sentence.endsWith("?"))!;
    return { headline: oneLine(run.length <= 160 ? run : lastQuestion), isQuestion: true };
  }
  const anyQuestion = [...paragraphs].reverse().flatMap((part) => sentencesOf(part).filter((sentence) => sentence.endsWith("?")).reverse())[0];
  if (anyQuestion) return { headline: oneLine(anyQuestion), isQuestion: true };
  return { headline: oneLine(last || "Claude finished its turn."), isQuestion: false };
}

/** The one thing a tool call is about: the file, the command's first line, the URL. */
function target(toolName: string, input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  const pick = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : "");
  const file = pick("file_path") || pick("notebook_path") || pick("path");
  if (file) return file.split(/[\\/]/).slice(-2).join("/");
  const command = pick("command");
  if (command) return command.split("\n")[0];
  return pick("url") || pick("pattern") || pick("query") || pick("description") || (toolName.startsWith("mcp__") ? toolName.split("__").pop() ?? "" : "");
}

export function present(interaction: Interaction, sessionTitle: string): Presented {
  const data = interaction.data ?? {};
  const answerable = interaction.status === "open";
  const base = { kind: interaction.kind, sessionTitle, answerable, quickReplies: [] as Choice[] };

  switch (interaction.kind) {
    case "permission": {
      const tool = String(data.toolName ?? "a tool");
      const what = target(tool, data.toolInput);
      const shortTool = tool.startsWith("mcp__") ? tool.replace(/^mcp__/, "").split("__")[0] : tool;
      return {
        ...base,
        headline: oneLine(`${shortTool}${what ? ` → ${what}` : ""}`, 120),
        question: data.agent ? `The ${data.agent} agent asks to use ${tool}.` : `Claude asks to use ${tool}.`,
        choices: [
          { ref: "o:0", label: "Allow", tone: "primary" },
          { ref: "o:1", label: "Allow for this session" },
          { ref: "o:2", label: "Deny", tone: "danger" },
        ],
        freeText: "Deny with a reason for Claude...",
        details: { label: "Full request", text: interaction.body, format: "code" },
      };
    }
    case "question": {
      const questions: PresentedQuestion[] = (Array.isArray(data.questions) ? data.questions : []).map((item: any) => ({
        header: item?.header ? String(item.header) : undefined,
        question: String(item?.question ?? ""),
        options: (Array.isArray(item?.options) ? item.options : []).map((option: any) => ({
          label: String(option?.label ?? option),
          description: option?.description ? String(option.description) : undefined,
        })),
        multiSelect: Boolean(item?.multiSelect),
      }));
      const first = questions[0];
      // One question is answered with one tap; several need every answer first, so no buttons.
      const single = questions.length === 1;
      return {
        ...base,
        headline: oneLine(first?.question || interaction.body || interaction.title),
        question: first?.header,
        questions,
        choices: single ? first.options.map((option, index) => ({ ref: `o:${index}`, label: option.label, description: option.description, tone: index === 0 ? "primary" : undefined })) : [],
        freeText: "Or answer in your own words...",
      };
    }
    case "turn": {
      const { headline, isQuestion } = mainQuestion(interaction.body);
      const replies = isQuestion ? ["Yes", "No", "Continue"] : ["Continue"];
      return {
        ...base,
        headline,
        choices: [],
        quickReplies: replies.map((label, index) => ({ ref: `q:${index}`, label })),
        freeText: "Reply to the session...",
        details: interaction.body && plain(interaction.body) !== headline ? { label: "Full message", text: interaction.body, format: "markdown" } : undefined,
        gist: interaction.body ? gistOf(interaction.body, headline) : undefined,
      };
    }
    case "mcp":
      return {
        ...base,
        headline: oneLine(`Needs the MCP server '${data.name ?? ""}'`),
        question: data.reason ? oneLine(String(data.reason), 240) : undefined,
        choices: [
          { ref: "o:0", label: "Install & resume", tone: "primary" },
          { ref: "o:1", label: "Skip" },
        ],
        freeText: "Or tell Claude what to do instead...",
        details: data.command ? { label: "Install command", text: String(data.command), format: "code" } : undefined,
      };
    case "done": {
      const deliverables = Object.entries((data.deliverables ?? {}) as Record<string, unknown>)
        .map(([key, value]) => `- **${key}**: ${typeof value === "string" ? value : JSON.stringify(value)}`)
        .join("\n");
      return {
        ...base,
        answerable: false,
        headline: oneLine(String(data.summary ?? interaction.body ?? "Task done."), 200),
        question: data.category ? `Category: ${data.category}` : undefined,
        choices: [],
        freeText: null,
        details: deliverables ? { label: "Deliverables", text: deliverables, format: "markdown" } : undefined,
      };
    }
  }
}

/** The answer a button stands for, as the session should receive it. */
export function resolveChoice(interaction: Interaction, ref: string): string | null {
  const [type, raw] = ref.split(":");
  const index = Number(raw);
  if (!Number.isInteger(index)) return null;
  if (type === "q") return present(interaction, "").quickReplies[index]?.label ?? null;
  if (type !== "o") return null;
  switch (interaction.kind) {
    case "permission":
      return ["1", "2", "3"][index] ?? null;
    case "question":
      return String(index + 1);
    case "mcp":
      return ["install", "skip"][index] ?? null;
    default:
      return null;
  }
}
