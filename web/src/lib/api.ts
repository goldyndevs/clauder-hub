import type {
  Category,
  Channel,
  ChannelKindInfo,
  ClaudeSettings,
  ClaudeStatus,
  Folders,
  GlobalInboxItem,
  GlobalProject,
  LiveProject,
  Health,
  ProjectInfo,
  Interaction,
  Inventory,
  Job,
  ParamValues,
  MemoryFile,
  CatalogItem,
  McpCatalogEntry,
  Preset,
  PromptDefinition,
  PurposeKind,
  Run,
  Session,
  SessionSetup,
  SessionDetail,
  Stats,
  Suggestion,
  Toolset,
  Variable,
} from "./types";
import { projectApi } from "./project";

/** A call to the open project's API. */
function request<T>(url: string, init?: RequestInit): Promise<T> {
  return call<T>(`${projectApi()}${url}`, init);
}

/** A call to the hub's own API: projects, folders. */
function hubRequest<T>(url: string, init?: RequestInit): Promise<T> {
  return call<T>(`/api${url}`, init);
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  let payload: any = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    // A proxy or a crash can answer with HTML; surface it instead of blowing up on parse.
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    throw new Error("The server returned a response that was not JSON.");
  }
  if (!response.ok) throw new Error(payload.error ?? response.statusText);
  return payload as T;
}

const post = <T>(url: string, body?: unknown) => request<T>(url, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
const put = <T>(url: string, body: unknown) => request<T>(url, { method: "PUT", body: JSON.stringify(body) });
const del = <T>(url: string) => request<T>(url, { method: "DELETE" });

export interface TerminalSize {
  cols?: number;
  rows?: number;
}

export const api = {
  health: () => request<Health>("/health"),

  hub: () => hubRequest<{ version: string; claudeStatus: ClaudeStatus | null }>("/hub"),
  /** Claude Code looked at again, after installing it or signing in. */
  checkClaude: () => hubRequest<ClaudeStatus>("/claude/check", { method: "POST" }),
  projects: () => hubRequest<ProjectInfo[]>("/projects"),
  addProject: (path: string) => hubRequest<ProjectInfo>("/projects", { method: "POST", body: JSON.stringify({ path }) }),
  openedProject: (id: string) => hubRequest(`/projects/${encodeURIComponent(id)}/open`, { method: "POST" }),
  removeProject: (id: string) => hubRequest(`/projects/${encodeURIComponent(id)}`, { method: "DELETE" }),
  folders: (path?: string) => hubRequest<Folders>(`/folders${path ? `?path=${encodeURIComponent(path)}` : ""}`),

  // #/global: every project at once. Answers go to the project an interaction is in, whichever is open.
  globalOverview: () => hubRequest<GlobalProject[]>("/global/overview"),
  globalInbox: () => hubRequest<GlobalInboxItem[]>("/global/inbox"),
  globalLive: () => hubRequest<LiveProject[]>("/global/live"),
  /** Off the live panel's list, the running ones stopped. */
  closeOpenSessions: (projectId: string, ids: string[]) =>
    call(`/api/p/${encodeURIComponent(projectId)}/open-sessions/close`, { method: "POST", body: JSON.stringify({ ids }) }),
  /** A plain session in any project, not only the open one (the live panel). */
  startSessionIn: (projectId: string, size: TerminalSize) =>
    call<{ sessionId: string; terminalId: string }>(`/api/p/${encodeURIComponent(projectId)}/sessions`, { method: "POST", body: JSON.stringify(size) }),
  setMuted: (projectId: string, muted: boolean) => hubRequest(`/global/muted/${encodeURIComponent(projectId)}`, { method: "PUT", body: JSON.stringify({ muted }) }),
  answerIn: (projectId: string, id: string, answer: string) =>
    hubRequest<Interaction>(`/p/${encodeURIComponent(projectId)}/interactions/${id}/answer`, { method: "POST", body: JSON.stringify({ answer }) }),
  chooseIn: (projectId: string, id: string, ref: string) =>
    hubRequest<Interaction>(`/p/${encodeURIComponent(projectId)}/interactions/${id}/choose`, { method: "POST", body: JSON.stringify({ ref }) }),

  pauseNotificationsIn: (projectId: string, paused: boolean) =>
    hubRequest<{ paused: boolean }>(`/p/${encodeURIComponent(projectId)}/notifications/paused`, { method: "PUT", body: JSON.stringify({ paused }) }),
  revealIn: (projectId: string) => hubRequest<{ path: string }>(`/p/${encodeURIComponent(projectId)}/files/reveal`, { method: "POST", body: JSON.stringify({ path: "" }) }),
  dismissIn: (projectId: string, id: string) => hubRequest<Interaction>(`/p/${encodeURIComponent(projectId)}/interactions/${id}/dismiss`, { method: "POST" }),

  sessions: () => request<Session[]>("/sessions"),
  /** Another project's sessions, read before switching to it. */
  sessionsIn: (projectId: string) => call<Session[]>(`/api/p/${encodeURIComponent(projectId)}/sessions`),
  session: (id: string) => request<SessionDetail>(`/sessions/${id}`),
  startSession: (body: { prompt?: string; category?: string; name?: string; permissionMode?: string } & TerminalSize) =>
    post<{ sessionId: string; terminalId: string }>("/sessions", body),
  /** Opens a Claude session for one configuration task; a form hands over what it had as the draft. */
  startPurpose: (kind: PurposeKind, targetId?: string, size: TerminalSize = {}, draft?: Record<string, unknown>) =>
    post<{ sessionId: string; terminalId: string }>("/purpose-sessions", { kind, targetId, draft, ...size }),
  resumeSession: (id: string, size: TerminalSize = {}) => post<{ sessionId: string; terminalId: string }>(`/sessions/${id}/resume`, size),
  /** With a project id, a session of that project rather than the open one (the live panel). */
  killSession: (id: string, projectId?: string) =>
    projectId ? call(`/api/p/${encodeURIComponent(projectId)}/sessions/${id}/kill`, { method: "POST" }) : post(`/sessions/${id}/kill`),
  renameSession: (id: string, title: string, projectId?: string) =>
    projectId
      ? call(`/api/p/${encodeURIComponent(projectId)}/sessions/${id}/title`, { method: "PUT", body: JSON.stringify({ title }) })
      : put(`/sessions/${id}/title`, { title }),
  deletionPlan: (id: string) =>
    request<{
      sessionId: string;
      files: Array<{ path: string; bytes: number; what: string }>;
      totalBytes: number;
      temp: { path: string; bytes: number } | null;
    }>(`/sessions/${id}/deletion`),
  deleteSession: (id: string, clearTemp = true) => del(`/sessions/${id}?temp=${clearTemp ? 1 : 0}`),

  interactions: (status?: string) => request<Interaction[]>(`/interactions${status ? `?status=${status}` : ""}`),
  answer: (id: string, answer: string) => post<Interaction>(`/interactions/${id}/answer`, { answer }),
  /** A button press; the hub turns the button back into the answer it stands for. */
  choose: (id: string, ref: string) => post<Interaction>(`/interactions/${id}/choose`, { ref }),
  /** Put away unanswered; nothing reaches the session. */
  dismiss: (id: string) => post<Interaction>(`/interactions/${id}/dismiss`),

  inventory: () => request<Inventory>("/inventory"),
  stats: () => request<Stats>("/stats"),

  categories: () => request<Category[]>("/categories"),
  saveCategory: (category: Partial<Category> & { name: string }) =>
    category.id ? put<Category>(`/categories/${category.id}`, category) : post<Category>("/categories", category),
  deleteCategory: (id: string) => del(`/categories/${id}`),

  prompts: () => request<PromptDefinition[]>("/prompts"),
  savePrompt: (key: string, text: string | null) => put<PromptDefinition[]>(`/prompts/${key}`, { text }),
  previewSystemPrompt: (category: string) => request<{ text: string }>(`/prompts/preview?category=${encodeURIComponent(category)}`),

  memory: () => request<MemoryFile[]>("/memory"),
  memoryFile: (path: string) => request<{ path: string; content: string; writable: boolean }>(`/memory/file?path=${encodeURIComponent(path)}`),
  saveMemoryFile: (path: string, content: string) => put<{ path: string; content: string }>("/memory/file", { path, content }),

  channels: () => request<{ kinds: ChannelKindInfo[]; interactionKinds: string[]; channels: Channel[]; paused: boolean; notifyKinds: string[] }>("/channels"),
  /** Holds back every channel at once; questions still wait in the inbox. */
  setNotificationsPaused: (paused: boolean) => put<{ paused: boolean }>("/notifications/paused", { paused }),
  /** What is worth a notification, for every channel. */
  setNotifyKinds: (kinds: string[]) => put<{ notifyKinds: string[] }>("/notifications/kinds", { kinds }),
  setSessionQuiet: (id: string, quiet: boolean) => put<{ quiet: boolean }>(`/sessions/${id}/quiet`, { quiet }),
  dismissWaiting: (id: string) => post<{ dismissed: number }>(`/sessions/${id}/dismiss-waiting`),
  saveChannel: (channel: Partial<Channel> & { kind: string; name: string }) =>
    channel.id ? put<Channel>(`/channels/${channel.id}`, channel) : post<Channel>("/channels", channel),
  deleteChannel: (id: string) => del(`/channels/${id}`),
  testChannel: (id: string) => post(`/channels/${id}/test`),

  jobs: () => request<Job[]>("/jobs"),
  saveJob: (job: Partial<Job> & { name: string; kind: Job["kind"]; prompt: string }) => (job.id ? put<Job>(`/jobs/${job.id}`, job) : post<Job>("/jobs", job)),
  deleteJob: (id: string) => del(`/jobs/${id}`),
  rotateJobToken: (id: string) => post<Job>(`/jobs/${id}/rotate`),
  runJob: (id: string, params?: ParamValues) => post(`/jobs/${id}/run`, { params }),

  runs: () => request<Run[]>("/runs"),
  queueSettings: () => request<{ maxRuns: number; limit: number }>("/queue-settings"),
  saveQueueSettings: (maxRuns: number) => put<{ maxRuns: number; limit: number }>("/queue-settings", { maxRuns }),
  queueRun: (prompt: string, category: string) => post("/runs", { prompt, category }),
  cancelRun: (id: string) => post(`/runs/${id}/cancel`),
  stopRun: (id: string) => post(`/runs/${id}/stop`),
  resumeRun: (id: string) => post<{ position: number }>(`/runs/${id}/resume`),

  toolsetCatalog: () => request<CatalogItem[]>("/toolset/catalog"),
  setSessionToolset: (id: string, toolset: Toolset) => put<{ restarted: boolean; terminalId?: string }>(`/sessions/${id}/toolset`, { toolset }),
  setSessionSetup: (id: string, setup: SessionSetup) => put<{ restarted: boolean; terminalId?: string }>(`/sessions/${id}/setup`, setup),
  variables: () => request<Variable[]>("/variables"),
  variableValue: (id: string) => request<{ value: string | null }>(`/variables/${id}/value`),
  saveVariable: (id: string, value: string) => put<Variable>(`/variables/${id}`, { value }),
  setVariableExpiry: (id: string, expiresAt: string | null) => put<Variable>(`/variables/${id}/expiry`, { expiresAt }),
  checkVariable: (id: string) => post<Variable>(`/variables/${id}/check`),
  presets: () => request<Preset[]>("/presets"),
  savePreset: (preset: Partial<Preset> & { name: string; toolset: Toolset }) =>
    preset.id ? put<Preset>(`/presets/${preset.id}`, preset) : post<Preset>("/presets", preset),
  deletePreset: (id: string) => del(`/presets/${id}`),
  setDefaultItem: (kind: keyof Toolset, id: string, enabled: boolean) => put<Preset>("/toolset/default", { kind, id, enabled }),

  claudeSettings: () => request<{ settings: ClaudeSettings; permissionModes: string[]; efforts: string[] }>("/claude-settings"),
  saveClaudeSettings: (patch: Partial<ClaudeSettings>) => put<ClaudeSettings>("/claude-settings", patch),

  mcpCatalog: () => request<McpCatalogEntry[]>("/mcp/catalog"),
  suggestions: () => request<Suggestion[]>("/mcp/suggestions"),
  mcpSuggestionsEnabled: () => request<{ enabled: boolean }>("/mcp-suggestions/enabled"),
  setMcpSuggestionsEnabled: (enabled: boolean) => put<{ enabled: boolean }>("/mcp-suggestions/enabled", { enabled }),
  installSuggestion: (id: string) => post<Suggestion>(`/mcp/suggestions/${id}/install`),
  skipSuggestion: (id: string, note = "") => post<Suggestion>(`/mcp/suggestions/${id}/skip`, { note }),
  deleteSuggestion: (id: string) => del(`/mcp/suggestions/${id}`),
};
