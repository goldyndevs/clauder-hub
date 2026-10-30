import type {
  Category,
  Channel,
  ChannelKindInfo,
  ClaudeSettings,
  Folders,
  GlobalInboxItem,
  GlobalProject,
  Health,
  ProjectInfo,
  Interaction,
  Inventory,
  Job,
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

  projects: () => hubRequest<ProjectInfo[]>("/projects"),
  addProject: (path: string) => hubRequest<ProjectInfo>("/projects", { method: "POST", body: JSON.stringify({ path }) }),
  openedProject: (id: string) => hubRequest(`/projects/${encodeURIComponent(id)}/open`, { method: "POST" }),
  removeProject: (id: string) => hubRequest(`/projects/${encodeURIComponent(id)}`, { method: "DELETE" }),
  folders: (path?: string) => hubRequest<Folders>(`/folders${path ? `?path=${encodeURIComponent(path)}` : ""}`),

  // #/global: every project at once. Answers go to the project an interaction is in, whichever is open.
  globalOverview: () => hubRequest<GlobalProject[]>("/global/overview"),
  globalInbox: () => hubRequest<GlobalInboxItem[]>("/global/inbox"),
  setMuted: (projectId: string, muted: boolean) => hubRequest(`/global/muted/${encodeURIComponent(projectId)}`, { method: "PUT", body: JSON.stringify({ muted }) }),
  answerIn: (projectId: string, id: string, answer: string) =>
    hubRequest<Interaction>(`/p/${encodeURIComponent(projectId)}/interactions/${id}/answer`, { method: "POST", body: JSON.stringify({ answer }) }),
  chooseIn: (projectId: string, id: string, ref: string) =>
    hubRequest<Interaction>(`/p/${encodeURIComponent(projectId)}/interactions/${id}/choose`, { method: "POST", body: JSON.stringify({ ref }) }),

  sessions: () => request<Session[]>("/sessions"),
  session: (id: string) => request<SessionDetail>(`/sessions/${id}`),
  startSession: (body: { prompt?: string; category?: string; name?: string; permissionMode?: string } & TerminalSize) =>
    post<{ sessionId: string; terminalId: string }>("/sessions", body),
  /** Opens a Claude session for one configuration task; the hub has no forms. */
  startPurpose: (kind: PurposeKind, targetId?: string, size: TerminalSize = {}) =>
    post<{ sessionId: string; terminalId: string }>("/purpose-sessions", { kind, targetId, ...size }),
  resumeSession: (id: string, size: TerminalSize = {}) => post<{ sessionId: string; terminalId: string }>(`/sessions/${id}/resume`, size),
  killSession: (id: string) => post(`/sessions/${id}/kill`),
  renameSession: (id: string, title: string) => put(`/sessions/${id}/title`, { title }),
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

  channels: () => request<{ kinds: ChannelKindInfo[]; interactionKinds: string[]; channels: Channel[] }>("/channels"),
  saveChannel: (channel: Partial<Channel> & { kind: string; name: string }) =>
    channel.id ? put<Channel>(`/channels/${channel.id}`, channel) : post<Channel>("/channels", channel),
  deleteChannel: (id: string) => del(`/channels/${id}`),
  testChannel: (id: string) => post(`/channels/${id}/test`),

  jobs: () => request<Job[]>("/jobs"),
  saveJob: (job: Partial<Job> & { name: string; kind: Job["kind"]; prompt: string }) => (job.id ? put<Job>(`/jobs/${job.id}`, job) : post<Job>("/jobs", job)),
  deleteJob: (id: string) => del(`/jobs/${id}`),
  rotateJobToken: (id: string) => post<Job>(`/jobs/${id}/rotate`),
  runJob: (id: string) => post(`/jobs/${id}/run`, {}),

  runs: () => request<Run[]>("/runs"),
  queueRun: (prompt: string, category: string) => post("/runs", { prompt, category }),
  cancelRun: (id: string) => post(`/runs/${id}/cancel`),

  toolsetCatalog: () => request<CatalogItem[]>("/toolset/catalog"),
  setSessionToolset: (id: string, toolset: Toolset) => put<{ restarted: boolean; terminalId?: string }>(`/sessions/${id}/toolset`, { toolset }),
  setSessionSetup: (id: string, setup: SessionSetup) => put<{ restarted: boolean; terminalId?: string }>(`/sessions/${id}/setup`, setup),
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
