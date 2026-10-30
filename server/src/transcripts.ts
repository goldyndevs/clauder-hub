import { bindProject, currentProject } from "./context.js";
import fs from "node:fs";
import path from "node:path";
import { broadcast } from "./events.js";
import { transcriptsDir } from "./paths.js";

/**
 * Everything the dashboard shows about what a session did comes from the
 * transcripts Claude Code writes anyway. Nothing is asked of the session, so
 * watching it cannot slow it down or change what it does.
 *
 * The JSONL layout is Claude Code's own and not a public contract, so every
 * field is read defensively: an unknown line is skipped, never fatal.
 */

export interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export interface ToolCall {
  id: string;
  name: string;
  ts: string;
  /** One line about what it was called with, for the activity list. */
  summary: string;
  error?: boolean;
}

interface Usage extends Tokens {
  model: string;
}

/** What one JSONL file has said so far. Fed incrementally as the file grows. */
class TranscriptAccumulator {
  offset = 0;
  partial = "";
  mtimeMs = 0;
  size = 0;

  title: string | null = null;
  customTitle: string | null = null;
  firstPrompt: string | null = null;
  lastPrompt: string | null = null;
  startedAt: string | null = null;
  lastAt: string | null = null;
  gitBranch: string | null = null;
  permissionMode: string | null = null;
  version: string | null = null;
  turns = 0;
  lastAssistantText: string | null = null;
  /** When a tool last returned: a dialog for it has been answered by then, wherever. */
  lastToolResultAt: string | null = null;
  /** Usage per API message id: Claude Code writes one line per content block, all carrying the same usage. */
  usage = new Map<string, Usage>();
  tools = new Map<string, ToolCall>();
  agentCalls = new Map<string, { subagentType: string; description: string; model?: string }>();
  commands = new Map<string, number>();

  feed(line: string): void {
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      return;
    }
    if (!record || typeof record !== "object") return;
    const ts: string | undefined = typeof record.timestamp === "string" ? record.timestamp : undefined;
    if (ts) {
      this.startedAt ??= ts;
      this.lastAt = ts;
    }
    if (record.gitBranch) this.gitBranch = record.gitBranch;
    if (record.version) this.version = record.version;

    switch (record.type) {
      case "ai-title":
        if (typeof record.aiTitle === "string") this.title = record.aiTitle;
        return;
      case "custom-title":
        if (typeof record.customTitle === "string") this.customTitle = record.customTitle;
        return;
      case "permission-mode":
        if (typeof record.permissionMode === "string") this.permissionMode = record.permissionMode;
        return;
      case "user":
        this.feedUser(record);
        return;
      case "assistant":
        this.feedAssistant(record, ts ?? this.lastAt ?? "");
        return;
    }
  }

  private feedUser(record: any): void {
    const content = record.message?.content;
    if (typeof content === "string") {
      if (record.isMeta) return;
      const command = /<command-name>\/?([^<]+)<\/command-name>/.exec(content);
      if (command) {
        const name = command[1].trim();
        this.commands.set(name, (this.commands.get(name) ?? 0) + 1);
        return;
      }
      // Hook output, caveats and other machinery arrive as tagged user text.
      if (content.startsWith("<")) return;
      this.turns += 1;
      this.firstPrompt ??= content.slice(0, 500);
      this.lastPrompt = content.slice(0, 500);
      return;
    }
    if (!Array.isArray(content)) return;
    for (const part of content) {
      if (part?.type === "tool_result") {
        if (typeof record.timestamp === "string") this.lastToolResultAt = record.timestamp;
        const call = typeof part.tool_use_id === "string" ? this.tools.get(part.tool_use_id) : undefined;
        if (call && part.is_error) call.error = true;
      } else if (part?.type === "text" && typeof part.text === "string" && !record.isMeta && !part.text.startsWith("<")) {
        this.turns += 1;
        this.firstPrompt ??= part.text.slice(0, 500);
        this.lastPrompt = part.text.slice(0, 500);
      }
    }
  }

  private feedAssistant(record: any, ts: string): void {
    const message = record.message;
    if (!message || typeof message !== "object") return;
    if (typeof message.id === "string" && message.usage) {
      const u = message.usage;
      this.usage.set(message.id, {
        model: String(message.model ?? "unknown"),
        input: Number(u.input_tokens) || 0,
        output: Number(u.output_tokens) || 0,
        cacheRead: Number(u.cache_read_input_tokens) || 0,
        cacheCreation: Number(u.cache_creation_input_tokens) || 0,
      });
    }
    if (!Array.isArray(message.content)) return;
    for (const part of message.content) {
      if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
        this.lastAssistantText = part.text;
      } else if (part?.type === "tool_use" && typeof part.id === "string" && !this.tools.has(part.id)) {
        const name = String(part.name ?? "unknown");
        this.tools.set(part.id, { id: part.id, name, ts, summary: summarise(name, part.input) });
        if (name === "Agent" || name === "Task") {
          this.agentCalls.set(part.id, {
            subagentType: String(part.input?.subagent_type ?? "general-purpose"),
            description: String(part.input?.description ?? ""),
            model: part.input?.model ? String(part.input.model) : undefined,
          });
        }
      }
    }
  }
}

function summarise(name: string, input: any): string {
  if (!input || typeof input !== "object") return "";
  const pick =
    name === "Skill"
      ? input.skill
      : name === "Agent" || name === "Task"
        ? `${input.subagent_type ?? "agent"}: ${input.description ?? ""}`
        : input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.query ?? input.description ?? input.prompt;
  if (typeof pick === "string") return pick.replace(/\s+/g, " ").slice(0, 160);
  const first = Object.values(input).find((value) => typeof value === "string") as string | undefined;
  return first ? first.replace(/\s+/g, " ").slice(0, 160) : "";
}

/** Reads whatever was appended since the last look. */
function refresh(file: string, acc: TranscriptAccumulator): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return false;
  }
  if (stat.size === acc.size && stat.mtimeMs === acc.mtimeMs) return false;
  // Rewritten in place (a compaction, or a fresh file with the same name): start over.
  if (stat.size < acc.offset) Object.assign(acc, new TranscriptAccumulator());
  acc.size = stat.size;
  acc.mtimeMs = stat.mtimeMs;
  if (stat.size === acc.offset) return true;

  const fd = fs.openSync(file, "r");
  try {
    const length = stat.size - acc.offset;
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, acc.offset);
    acc.offset = stat.size;
    const text = acc.partial + buffer.toString("utf8");
    const lines = text.split("\n");
    // The last piece is a line still being written.
    acc.partial = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) acc.feed(line);
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

interface SubagentState {
  acc: TranscriptAccumulator;
  meta: { agentType?: string; description?: string; toolUseId?: string; spawnDepth?: number; model?: string; isFork?: boolean };
  metaLoaded: boolean;
}

interface SessionState {
  id: string;
  file: string;
  acc: TranscriptAccumulator;
  subagents: Map<string, SubagentState>;
}

/** Every project's read transcripts, keyed <project id>:<session id>: a state holds its project's file. */
const sessions = new Map<string, SessionState>();
const stateKey = (id: string) => `${currentProject().id}:${id}`;

function sumTokens(usages: Iterable<Usage>): { total: Tokens; byModel: Record<string, Tokens> } {
  const total: Tokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  const byModel: Record<string, Tokens> = {};
  for (const usage of usages) {
    const bucket = (byModel[usage.model] ??= { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
    for (const key of ["input", "output", "cacheRead", "cacheCreation"] as const) {
      total[key] += usage[key];
      bucket[key] += usage[key];
    }
  }
  return { total, byModel };
}

function countTools(calls: Iterable<ToolCall>): Record<string, { count: number; errors: number }> {
  const counts: Record<string, { count: number; errors: number }> = {};
  for (const call of calls) {
    const entry = (counts[call.name] ??= { count: 0, errors: 0 });
    entry.count += 1;
    if (call.error) entry.errors += 1;
  }
  return counts;
}

function skillsOf(calls: Iterable<ToolCall>, commands: Map<string, number>): Record<string, number> {
  const skills: Record<string, number> = {};
  for (const call of calls) if (call.name === "Skill" && call.summary) skills[call.summary] = (skills[call.summary] ?? 0) + 1;
  for (const [name, count] of commands) skills[`/${name}`] = (skills[`/${name}`] ?? 0) + count;
  return skills;
}

function refreshSubagents(state: SessionState): boolean {
  const dir = path.join(transcriptsDir(), state.id, "subagents");
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return false;
  }
  let changed = false;
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const agentId = name.slice(0, -".jsonl".length).replace(/^agent-/, "");
    let sub = state.subagents.get(agentId);
    if (!sub) {
      sub = { acc: new TranscriptAccumulator(), meta: {}, metaLoaded: false };
      state.subagents.set(agentId, sub);
    }
    if (!sub.metaLoaded) {
      try {
        sub.meta = JSON.parse(fs.readFileSync(path.join(dir, `agent-${agentId}.meta.json`), "utf8"));
        sub.metaLoaded = true;
      } catch {
        // Written alongside the transcript; it may not be there yet.
      }
    }
    if (refresh(path.join(dir, name), sub.acc)) changed = true;
  }
  return changed;
}

/** Drops what was read of a session, for one whose files were just deleted. */
export function forgetTranscript(id: string): void {
  sessions.delete(stateKey(id));
}

function stateOf(id: string): SessionState | null {
  let state = sessions.get(stateKey(id));
  if (!state) {
    const file = path.join(transcriptsDir(), `${id}.jsonl`);
    if (!fs.existsSync(file)) return null;
    state = { id, file, acc: new TranscriptAccumulator(), subagents: new Map() };
    sessions.set(stateKey(id), state);
  }
  return state;
}

export interface SubagentSummary {
  id: string;
  agentType: string;
  description: string;
  toolUseId: string | null;
  depth: number;
  model: string | null;
  fork: boolean;
  startedAt: string | null;
  lastAt: string | null;
  tokens: Tokens;
  tools: Record<string, { count: number; errors: number }>;
  skills: Record<string, number>;
  recent: ToolCall[];
}

export interface TranscriptSummary {
  id: string;
  title: string;
  firstPrompt: string | null;
  lastPrompt: string | null;
  startedAt: string | null;
  lastAt: string | null;
  gitBranch: string | null;
  permissionMode: string | null;
  version: string | null;
  turns: number;
  size: number;
  tokens: Tokens;
  tokensByModel: Record<string, Tokens>;
  toolCalls: number;
  subagentCount: number;
}

export interface TranscriptDetail extends TranscriptSummary {
  tools: Record<string, { count: number; errors: number }>;
  skills: Record<string, number>;
  subagents: SubagentSummary[];
  recent: ToolCall[];
  lastAssistantText: string | null;
  /** Everything, main thread and every subagent together. */
  totals: { tokens: Tokens; tokensByModel: Record<string, Tokens>; tools: Record<string, { count: number; errors: number }> };
}

function summaryOf(state: SessionState): TranscriptSummary {
  const acc = state.acc;
  const all = allUsages(state);
  const { total, byModel } = sumTokens(all);
  return {
    id: state.id,
    title: acc.customTitle ?? acc.title ?? acc.firstPrompt?.slice(0, 80) ?? state.id.slice(0, 8),
    firstPrompt: acc.firstPrompt,
    lastPrompt: acc.lastPrompt,
    startedAt: acc.startedAt,
    lastAt: acc.lastAt,
    gitBranch: acc.gitBranch,
    permissionMode: acc.permissionMode,
    version: acc.version,
    turns: acc.turns,
    size: acc.size,
    tokens: total,
    tokensByModel: byModel,
    toolCalls: acc.tools.size + [...state.subagents.values()].reduce((sum, sub) => sum + ownTools(state, sub).length, 0),
    subagentCount: state.subagents.size,
  };
}

/** A fork's transcript starts with its parent's messages; those are counted once, on the parent. */
function ownUsages(state: SessionState, sub: SubagentState): Usage[] {
  return [...sub.acc.usage.entries()].filter(([id]) => !state.acc.usage.has(id)).map(([, usage]) => usage);
}

function ownTools(state: SessionState, sub: SubagentState): ToolCall[] {
  return [...sub.acc.tools.values()].filter((call) => !state.acc.tools.has(call.id));
}

function allUsages(state: SessionState): Usage[] {
  const seen = new Map(state.acc.usage);
  for (const sub of state.subagents.values()) for (const [id, usage] of sub.acc.usage) if (!seen.has(id)) seen.set(id, usage);
  return [...seen.values()];
}

export function listTranscripts(): TranscriptSummary[] {
  let names: string[];
  try {
    names = fs.readdirSync(transcriptsDir());
  } catch {
    return [];
  }
  const summaries: TranscriptSummary[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const state = stateOf(name.slice(0, -".jsonl".length));
    if (!state) continue;
    refresh(state.file, state.acc);
    refreshSubagents(state);
    // Sessions that never got past start-up (a /resume picker, an instant exit) say nothing.
    if (!state.acc.startedAt) continue;
    summaries.push(summaryOf(state));
  }
  return summaries.sort((a, b) => (b.lastAt ?? "").localeCompare(a.lastAt ?? ""));
}

export function transcriptDetail(id: string): TranscriptDetail | null {
  const state = stateOf(id);
  if (!state) return null;
  refresh(state.file, state.acc);
  refreshSubagents(state);

  const subagents: SubagentSummary[] = [...state.subagents.entries()].map(([agentId, sub]) => {
    const toolUseId = sub.meta.toolUseId ?? null;
    const call = toolUseId ? state.acc.agentCalls.get(toolUseId) : undefined;
    const tools = ownTools(state, sub);
    return {
      id: agentId,
      agentType: sub.meta.agentType ?? call?.subagentType ?? "agent",
      description: sub.meta.description ?? call?.description ?? "",
      toolUseId,
      depth: sub.meta.spawnDepth ?? 1,
      model: sub.meta.model ?? call?.model ?? null,
      fork: Boolean(sub.meta.isFork),
      startedAt: sub.acc.startedAt,
      lastAt: sub.acc.lastAt,
      tokens: sumTokens(ownUsages(state, sub)).total,
      tools: countTools(tools),
      skills: skillsOf(tools, new Map()),
      recent: tools.slice(-30),
    };
  });
  subagents.sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));

  const everyCall = [...state.acc.tools.values(), ...[...state.subagents.values()].flatMap((sub) => ownTools(state, sub))];
  const all = sumTokens(allUsages(state));
  return {
    ...summaryOf(state),
    tools: countTools(state.acc.tools.values()),
    skills: skillsOf(everyCall, state.acc.commands),
    subagents,
    recent: [...state.acc.tools.values()].slice(-80),
    lastAssistantText: state.acc.lastAssistantText,
    totals: { tokens: all.total, tokensByModel: all.byModel, tools: countTools(everyCall) },
  };
}

/** The last thing Claude said in a session, read fresh. */
export function lastAssistantText(id: string): string | null {
  const state = stateOf(id);
  if (!state) return null;
  refresh(state.file, state.acc);
  return state.acc.lastAssistantText;
}

/** The time of the session's latest tool result, read fresh; null before any. */
export function lastToolResultAt(id: string): string | null {
  const state = stateOf(id);
  if (!state) return null;
  refresh(state.file, state.acc);
  return state.acc.lastToolResultAt;
}

export function transcriptMtime(id: string): number {
  try {
    return fs.statSync(path.join(transcriptsDir(), `${id}.jsonl`)).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Polling, not fs.watch: recursive watching is unreliable across platforms, and
 * a stat per file every couple of seconds costs nothing next to a session.
 */
export function startTranscriptWatcher(intervalMs = 1500): () => void {
  const seen = new Map<string, number>();
  const tick = () => {
    let names: string[];
    try {
      names = fs.readdirSync(transcriptsDir());
    } catch {
      return;
    }
    let listChanged = false;
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const id = name.slice(0, -".jsonl".length);
      let stamp = 0;
      try {
        stamp = fs.statSync(path.join(transcriptsDir(), name)).mtimeMs;
      } catch {
        continue;
      }
      // Subagents write to their own files while the main one stays still.
      try {
        for (const sub of fs.readdirSync(path.join(transcriptsDir(), id, "subagents"))) {
          if (sub.endsWith(".jsonl")) stamp = Math.max(stamp, fs.statSync(path.join(transcriptsDir(), id, "subagents", sub)).mtimeMs);
        }
      } catch {
        // No subagents yet.
      }
      const before = seen.get(id);
      if (before === stamp) continue;
      seen.set(id, stamp);
      if (before === undefined) {
        listChanged = true;
        continue;
      }
      broadcast("transcript", { sessionId: id });
      listChanged = true;
    }
    if (listChanged) broadcast("sessions", {});
  };
  tick();
  // Ticks for the project that started the watcher.
  const timer = setInterval(bindProject(tick), intervalMs);
  return () => clearInterval(timer);
}
