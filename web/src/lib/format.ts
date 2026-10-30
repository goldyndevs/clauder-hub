import type { Tokens, ToolCounts } from "./types";

export function compact(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return String(value);
}

export function totalTokens(tokens?: Tokens | null): number {
  if (!tokens) return 0;
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreation;
}

export function ago(iso?: string | null): string {
  if (!iso) return "";
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function when(iso?: string | null): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** The four kinds of thing a session calls, as the dashboard groups them. */
export type ToolGroup = "built-in" | "agents" | "skills" | "mcp";

export function toolGroup(name: string): ToolGroup {
  if (name === "Agent" || name === "Task") return "agents";
  if (name === "Skill") return "skills";
  if (name.startsWith("mcp__")) return "mcp";
  return "built-in";
}

/** mcp__server__tool → { server, tool }. Server names may hold underscores, tool names rarely do. */
export function mcpParts(name: string): { server: string; tool: string } {
  const rest = name.slice("mcp__".length);
  const cut = rest.indexOf("__");
  return cut === -1 ? { server: rest, tool: "" } : { server: rest.slice(0, cut), tool: rest.slice(cut + 2) };
}

export function groupTools(tools: ToolCounts): Record<ToolGroup, Array<{ name: string; count: number; errors: number }>> {
  const groups: Record<ToolGroup, Array<{ name: string; count: number; errors: number }>> = { "built-in": [], agents: [], skills: [], mcp: [] };
  for (const [name, value] of Object.entries(tools)) groups[toolGroup(name)].push({ name, ...value });
  for (const list of Object.values(groups)) list.sort((a, b) => b.count - a.count);
  return groups;
}

export function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
