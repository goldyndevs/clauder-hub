export interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export type ToolCounts = Record<string, { count: number; errors: number }>;

export interface ToolCall {
  id: string;
  name: string;
  ts: string;
  summary: string;
  error?: boolean;
}

export type SessionStatus = "running" | "waiting" | "done" | "exited" | "external";

export interface Session {
  id: string;
  title: string;
  origin: "manual" | "cron" | "webhook" | "queue" | "external";
  status: SessionStatus;
  live: boolean;
  terminalId: string | null;
  category: string | null;
  runId: string | null;
  openInteractions: number;
  done: { category?: string; summary?: string; deliverables?: Record<string, unknown> } | null;
  /** Set on a configuration session: what it is for. */
  purpose: { kind: PurposeKind; targetId?: string; title: string } | null;
  firstPrompt?: string | null;
  lastPrompt?: string | null;
  startedAt?: string | null;
  lastAt?: string | null;
  gitBranch?: string | null;
  permissionMode?: string | null;
  version?: string | null;
  turns?: number;
  tokens?: Tokens;
  tokensByModel?: Record<string, Tokens>;
  toolCalls?: number;
  subagentCount?: number;
}

export interface Subagent {
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
  tools: ToolCounts;
  skills: Record<string, number>;
  recent: ToolCall[];
}

export interface SessionDetail {
  session: Session;
  detail: {
    tools: ToolCounts;
    skills: Record<string, number>;
    subagents: Subagent[];
    recent: ToolCall[];
    lastAssistantText: string | null;
    tokens: Tokens;
    tokensByModel: Record<string, Tokens>;
    totals: { tokens: Tokens; tokensByModel: Record<string, Tokens>; tools: ToolCounts };
  } | null;
  interactions: Interaction[];
  toolset: Toolset;
  setup: SessionSetup;
  /** The configuration session's note, as markdown: its purpose, every parameter, samples, the API. */
  purposeNote: string | null;
  systemPrompt: string | null;
}

export type InteractionKind = "permission" | "question" | "turn" | "mcp" | "done";

export interface Interaction {
  id: string;
  sessionId: string;
  kind: InteractionKind;
  title: string;
  body: string;
  options: Array<{ key: string; label: string }>;
  data: Record<string, any>;
  status: "open" | "answered" | "closed";
  answeredBy: string | null;
  answer: string | null;
  createdAt: string;
  updatedAt: string;
  /** What a person should see of it; the same shape every channel draws. */
  presented?: Presented;
}

export interface Choice {
  ref: string;
  label: string;
  description?: string;
  tone?: "primary" | "danger";
}

export interface Presented {
  kind: InteractionKind;
  sessionTitle: string;
  headline: string;
  question?: string;
  questions?: Array<{ header?: string; question: string; options: Array<{ label: string; description?: string }>; multiSelect: boolean }>;
  choices: Choice[];
  quickReplies: Choice[];
  freeText: string | null;
  details?: { label: string; text: string; format: "code" | "markdown" };
  answerable: boolean;
}

export interface Stats {
  sessions: number;
  tokens: Tokens;
  byModel: Record<string, Tokens>;
  byDay: Record<string, Tokens>;
  tools: ToolCounts;
  skills: Record<string, number>;
  agents: Record<string, { count: number; tokens: Tokens }>;
}

export type Scope = "user" | "project" | "local" | "plugin" | "built-in";

export interface DefinitionItem {
  name: string;
  description: string;
  scope: Scope;
  plugin?: string;
  path: string;
  model?: string;
}

export interface Inventory {
  agents: DefinitionItem[];
  skills: DefinitionItem[];
  commands: DefinitionItem[];
  mcpServers: Array<{ name: string; scope: Scope; plugin?: string; transport: string; target: string; source: string; disabled?: boolean }>;
  hooks: Array<{ event: string; matcher: string; type: string; scope: Scope; plugin?: string; source: string; summary: string }>;
  plugins: Array<{ id: string; version: string; scope: string; enabled: boolean; path: string }>;
}

export interface Category {
  id: string;
  name: string;
  description: string;
  deliverables: Array<{ name: string; description: string; required: boolean }>;
}

export interface PromptDefinition {
  key: string;
  label: string;
  audience: "claude-system" | "claude-typed" | "channel";
  description: string;
  placeholders: string[];
  text: string;
  defaultText: string;
  overridden: boolean;
}

export interface MemoryFile {
  path: string;
  label: string;
  group: "memory" | "rules" | "auto-memory" | "agent" | "skill" | "command";
  scope: Scope;
  exists: boolean;
}

export interface ChannelKindInfo {
  kind: string;
  label: string;
  twoWay: boolean;
  fields: Array<{ key: string; label: string; secret?: boolean; placeholder?: string; hint?: string; options?: string[] }>;
}

export interface Channel {
  id: string;
  kind: string;
  name: string;
  enabled: boolean;
  config: Record<string, string>;
  kinds: string[];
  createdAt: string;
  status: { ok: boolean; detail: string };
}

export interface Job {
  id: string;
  name: string;
  kind: "cron" | "webhook";
  schedule: string;
  prompt: string;
  category: string;
  presetId: string | null;
  token: string;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
}

export interface Run {
  id: string;
  jobId: string | null;
  jobName: string | null;
  source: "cron" | "webhook" | "manual";
  prompt: string;
  category: string;
  status: "queued" | "running" | "done" | "exited" | "cancelled";
  sessionId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface Suggestion {
  id: string;
  sessionId: string;
  name: string;
  reason: string;
  command: string;
  docs: string | null;
  status: "suggested" | "installed" | "failed" | "dismissed";
  output: string | null;
  runs: string | null;
  refused: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Health {
  ok: boolean;
  version: string;
  projectId: string;
  projectRoot: string;
  project: string;
  claude: string | null;
  transcriptsDir: string;
}

/** A project the hub manages, with what it is doing now. */
export interface ProjectInfo {
  id: string;
  name: string;
  root: string;
  addedAt: string;
  openedAt: string;
  exists: boolean;
  running: number;
  waiting: number;
}

/** One project's card on #/global. */
export interface GlobalProject {
  id: string;
  name: string;
  root: string;
  running: number;
  waiting: number;
  queued: number;
  /** The run going now: its job's name, "a run", or null. */
  runningRun: string | null;
  nextCron: { name: string; at: string } | null;
  activeToday: number;
  /** Sent and written in the sessions active today, cache reads left out. */
  tokensToday: number;
  /** The global channels do not hear from it. */
  muted: boolean;
}

/** Something waiting on a person, with the project it is in. */
export type GlobalInboxItem = Interaction & { project: { id: string; name: string } };

/** A folder listing for the Open folder dialog, from the hub's machine. */
export interface Folders {
  path: string;
  parent: string | null;
  home: string;
  drives: string[];
  folders: Array<{ name: string; path: string; git: boolean }>;
}

/** What is turned off for a session; everything else is on. */
export interface Toolset {
  agents: string[];
  skills: string[];
  mcp: string[];
  plugins: string[];
}

export interface CatalogItem {
  kind: keyof Toolset;
  id: string;
  label: string;
  description: string;
  scope: "built-in" | "user" | "project" | "local" | "plugin" | "connector";
  plugin?: string;
  /** False when turning it off only blocks its use and it still costs context. */
  leavesContext: boolean;
}

/** A session's own notes and named values, appended to its system prompt. */
export interface SessionSetup {
  notes: string;
  variables: Array<{ name: string; value: string }>;
}

export interface ClaudeSettings {
  permissionMode: string;
  runPermissionMode: string;
  model: string;
  fallbackModel: string;
  effort: string;
  addDirs: string[];
  chrome: string;
}

export interface Preset {
  id: string;
  name: string;
  toolset: Toolset;
  isDefault: boolean;
}

export type PurposeKind =
  | "hub"
  | "create-job"
  | "edit-job"
  | "queue-run"
  | "create-category"
  | "edit-category"
  | "create-preset"
  | "edit-preset"
  | "create-channel"
  | "edit-channel"
  | "add-mcp";

/** A well-known MCP server the MCP servers page recommends. */
export interface McpCatalogEntry {
  id: string;
  name: string;
  vendor: string;
  category: string;
  description: string;
  transport: "http" | "sse" | "stdio";
  auth?: "oauth" | "header" | "none";
  params: Array<{ name: string; kind: string; key: string; required: boolean; secret: boolean; description: string; example: string }>;
  serverName: string;
  addCommand: string;
  docs: string;
  installed: boolean;
}
