import { checkDone, type DoneReport } from "./categories.js";
import { closeOpen, createInteraction } from "./interactions.js";
import { createSuggestion } from "./mcpSuggestions.js";
import { renderPrompt } from "./prompts.js";
import { bumpDoneAttempts, getSessionRow, renameSession, setSessionStatus, terminalByToken } from "./sessions.js";
import { killTerminal, typeMessage, type Terminal } from "./terminals.js";
import { lastAssistantText } from "./transcripts.js";

/**
 * What the hub's HTTP hooks report. The route answers each call at once with
 * an empty object, before any of this runs, so a hook never waits on the hub
 * and never makes a decision for Claude.
 */
const MAX_DONE_ATTEMPTS = 3;

/** A <<NAME>> ... <</NAME>> block from Claude's last message, parsed. */
export function extractBlock(text: string, name: string): any | null {
  const match = new RegExp(`<<${name}>>([\\s\\S]*?)<</${name}>>`).exec(text);
  if (!match) return null;
  const body = match[1].trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

function inputPreview(input: unknown): string {
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    if (typeof record.command === "string") return record.command;
    if (typeof record.file_path === "string" && typeof record.content === "string") return `${record.file_path}\n\n${record.content.slice(0, 600)}`;
  }
  const text = JSON.stringify(input, null, 2) ?? "";
  return text.length > 1500 ? `${text.slice(0, 1500)}\n...` : text;
}

async function onStop(terminal: Terminal, payload: any): Promise<void> {
  const sessionId = terminal.sessionId;
  // The turn is over, so any dialog it raised was dealt with at the keyboard.
  closeOpen(sessionId, "terminal", ["permission", "question"]);
  const message: string = typeof payload.last_assistant_message === "string" ? payload.last_assistant_message : (lastAssistantText(sessionId) ?? "");

  const suggestion = extractBlock(message, "CLAUDER_MCP_SUGGEST");
  if (suggestion && createSuggestion(sessionId, suggestion)) return;

  const row = getSessionRow(sessionId);
  const done = row?.category ? (extractBlock(message, "CLAUDER_DONE") as DoneReport | null) : null;
  if (done) {
    const problems = checkDone(done, row?.category ?? null);
    if (problems.length && bumpDoneAttempts(sessionId) < MAX_DONE_ATTEMPTS) {
      await typeMessage(terminal, renderPrompt("typed.missing", { problems: problems.map((item) => `- ${item}`).join("\n") }));
      return;
    }
    const report = { ...done, category: row?.category && row.category !== "auto" ? row.category : done.category, problems };
    setSessionStatus(sessionId, "done", { done_json: JSON.stringify(report) });
    createInteraction({
      sessionId,
      kind: "done",
      title: "Task done",
      body: String(done.summary ?? ""),
      data: report,
      closed: true,
    });
    // Done means done: the terminal closes and the queue moves on.
    terminal.finished = true;
    setTimeout(() => killTerminal(terminal), 1500);
    return;
  }

  const visible = message.replace(/<<CLAUDER_[A-Z_]+>>[\s\S]*?<<\/CLAUDER_[A-Z_]+>>/g, "").trim();
  createInteraction({
    sessionId,
    kind: "turn",
    title: "Waiting for your reply",
    body: visible.length > 3000 ? `${visible.slice(0, 3000)}\n...` : visible || "(Claude finished its turn without a message.)",
  });
}

export async function handleHook(token: string, payload: any): Promise<void> {
  const terminal = terminalByToken(token);
  if (!terminal || !payload || typeof payload !== "object") return;
  const event = String(payload.hook_event_name ?? "");
  // Subagents fire hooks too. Their dialogs block like the main thread's and are
  // relayed, labelled; their turns and lifecycle are not the session's.
  const agent: string | null = payload.agent_id ? String(payload.agent_type ?? "subagent") : null;
  if (agent && !["PermissionRequest", "PreToolUse", "Notification"].includes(event)) return;

  if (!agent && typeof payload.session_id === "string" && payload.session_id && payload.session_id !== terminal.sessionId) {
    renameSession(terminal.sessionId, payload.session_id);
    terminal.sessionId = payload.session_id;
  }
  const sessionId = terminal.sessionId;

  switch (event) {
    case "UserPromptSubmit":
      closeOpen(sessionId, "terminal");
      if (getSessionRow(sessionId)?.status !== "done") setSessionStatus(sessionId, "running");
      return;
    case "PermissionRequest":
      // A question is its own dialog, already raised from PreToolUse.
      if (payload.tool_name === "AskUserQuestion") return;
      createInteraction({
        sessionId,
        kind: "permission",
        title: `Use ${payload.tool_name ?? "a tool"}?${agent ? ` (asked by the ${agent} agent)` : ""}`,
        body: inputPreview(payload.tool_input),
        options: [
          { key: "1", label: "Allow" },
          { key: "2", label: "Allow for this session" },
          { key: "3", label: "Deny" },
        ],
        data: { toolName: payload.tool_name, toolInput: payload.tool_input, agent },
      });
      return;
    case "PreToolUse":
      if (payload.tool_name !== "AskUserQuestion") return;
      createInteraction({
        sessionId,
        kind: "question",
        title: agent ? `The ${agent} agent asks` : "Claude asks",
        body: (payload.tool_input?.questions ?? []).map((item: any) => item.question).join("\n"),
        options: (payload.tool_input?.questions?.[0]?.options ?? []).map((option: any, index: number) => ({
          key: String(index + 1),
          label: String(option.label ?? option),
        })),
        data: { questions: payload.tool_input?.questions ?? [] },
      });
      return;
    case "Notification": {
      // PermissionRequest already carries the detail; this only covers dialogs it does not.
      const type = String(payload.notification_type ?? "");
      if (type === "elicitation_dialog") {
        createInteraction({ sessionId, kind: "question", title: "An MCP server asks for input", body: String(payload.message ?? ""), data: {} });
      }
      return;
    }
    case "Stop":
      await onStop(terminal, payload);
      return;
    case "SessionEnd":
      closeOpen(sessionId, "session end");
      return;
  }
}
