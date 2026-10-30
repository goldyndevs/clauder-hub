import { nanoid } from "nanoid";
import { db, now, parseJson } from "./db.js";
import { broadcast } from "./events.js";
import { readInventory } from "./inventory.js";
import { listTranscripts, transcriptDetail } from "./transcripts.js";

/**
 * What one session may use. Everything is on unless listed here; the lists
 * name what is turned off. It reaches Claude Code only through the session's
 * own --settings, so no file of the user's changes, and it applies at start-up:
 * changing it on a live session means restarting that session on --resume.
 *
 * How each kind is turned off, as measured against Claude Code 2.1.312:
 * - a plugin: enabledPlugins false. Its skills, agents and servers leave the context.
 * - a user or project skill: skillOverrides "off". It leaves the context.
 * - an agent, built-in or not: a deny rule Agent(name). It leaves the agent list.
 * - a plugin's skill: a deny rule Skill(name). Only its use is blocked; it stays listed.
 * - an MCP server: a deny rule on mcp__server. Its calls are blocked; whether its
 *   tool definitions leave the context is not documented, so the page says "blocks use".
 */
export interface Toolset {
  agents: string[];
  skills: string[];
  mcp: string[];
  plugins: string[];
}

export const EMPTY_TOOLSET: Toolset = { agents: [], skills: [], mcp: [], plugins: [] };

export function normaliseToolset(input: unknown): Toolset {
  const value = (input ?? {}) as Partial<Record<keyof Toolset, unknown>>;
  const list = (items: unknown) => [...new Set((Array.isArray(items) ? items : []).map(String).filter(Boolean))].sort();
  return { agents: list(value.agents), skills: list(value.skills), mcp: list(value.mcp), plugins: list(value.plugins) };
}

export function isEmptyToolset(toolset: Toolset): boolean {
  return !toolset.agents.length && !toolset.skills.length && !toolset.mcp.length && !toolset.plugins.length;
}

export interface CatalogItem {
  kind: keyof Toolset;
  /** What goes into the toolset list. */
  id: string;
  label: string;
  description: string;
  scope: "built-in" | "user" | "project" | "local" | "plugin" | "connector";
  plugin?: string;
  /** False when turning it off only blocks its use and it still costs context. */
  leavesContext: boolean;
}

/** Claude Code names an MCP tool mcp__<server>__<tool>, with anything else than [A-Za-z0-9_-] as "_". */
const toolName = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "_");

function mcpPrefix(server: { name: string; scope: string; plugin?: string }): string {
  if (server.scope !== "plugin") return `mcp__${toolName(server.name)}`;
  // The inventory names a plugin's server plugin:<plugin>:<server>.
  const [, plugin = "", name = ""] = server.name.split(":");
  return `mcp__plugin_${toolName(plugin)}_${toolName(name)}`;
}

/** claude.ai connectors live in the account, not a file; the ones this project has called are known from its transcripts. */
function connectorsSeen(): string[] {
  const prefixes = new Set<string>();
  for (const summary of listTranscripts()) {
    for (const name of Object.keys(transcriptDetail(summary.id)?.totals.tools ?? {})) {
      const match = /^(mcp__claude_ai_[A-Za-z0-9_-]+?)__/.exec(name);
      if (match) prefixes.add(match[1]);
    }
  }
  return [...prefixes].sort();
}

export function toolsetCatalog(): CatalogItem[] {
  const inventory = readInventory();
  const items: CatalogItem[] = [];

  for (const plugin of inventory.plugins.filter((item) => item.enabled)) {
    items.push({ kind: "plugins", id: plugin.id, label: plugin.id, description: `v${plugin.version}`, scope: plugin.scope === "user" ? "user" : "project", leavesContext: true });
  }
  for (const agent of inventory.agents) {
    items.push({ kind: "agents", id: agent.name, label: agent.name, description: agent.description, scope: agent.scope, plugin: agent.plugin, leavesContext: true });
  }
  for (const skill of inventory.skills) {
    items.push({ kind: "skills", id: skill.name, label: skill.name, description: skill.description, scope: skill.scope, plugin: skill.plugin, leavesContext: skill.scope !== "plugin" });
  }
  for (const server of inventory.mcpServers) {
    items.push({ kind: "mcp", id: mcpPrefix(server), label: server.name, description: server.target, scope: server.scope, plugin: server.plugin, leavesContext: false });
  }
  for (const prefix of connectorsSeen()) {
    items.push({ kind: "mcp", id: prefix, label: prefix.replace(/^mcp__claude_ai_/, "claude.ai ").replace(/_/g, " "), description: "claude.ai connector", scope: "connector", leavesContext: false });
  }
  // One entry per id: a server configured twice is one server to Claude Code.
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.kind}:${item.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The settings keys that turn a toolset into what Claude Code does, merged into the session's --settings. */
export function toolsetSettings(toolset: Toolset): Record<string, unknown> {
  if (isEmptyToolset(toolset)) return {};
  const pluginSkills = new Set(readInventory().skills.filter((skill) => skill.scope === "plugin").map((skill) => skill.name));
  const deny = [
    ...toolset.agents.map((name) => `Agent(${name})`),
    ...toolset.skills.filter((name) => pluginSkills.has(name)).map((name) => `Skill(${name})`),
    ...toolset.mcp,
  ];
  const overrides = Object.fromEntries(toolset.skills.filter((name) => !pluginSkills.has(name)).map((name) => [name, "off"]));
  const settings: Record<string, unknown> = {};
  if (deny.length) settings.permissions = { deny };
  if (Object.keys(overrides).length) settings.skillOverrides = overrides;
  if (toolset.plugins.length) settings.enabledPlugins = Object.fromEntries(toolset.plugins.map((id) => [id, false]));
  return settings;
}

// Presets ----------------------------------------------------------------

export interface Preset {
  id: string;
  name: string;
  toolset: Toolset;
  isDefault: boolean;
}

interface PresetRow {
  id: string;
  name: string;
  toolset: string;
  is_default: number;
}

const toPreset = (row: PresetRow): Preset => ({ id: row.id, name: row.name, toolset: normaliseToolset(parseJson(row.toolset, {})), isDefault: Boolean(row.is_default) });

export function listPresets(): Preset[] {
  return (db.prepare("SELECT * FROM presets ORDER BY name COLLATE NOCASE").all() as PresetRow[]).map(toPreset);
}

export function getPreset(id: string): Preset | null {
  const row = db.prepare("SELECT * FROM presets WHERE id = ?").get(id) as PresetRow | undefined;
  return row ? toPreset(row) : null;
}

/** The toolset a session gets when nobody chose one: the default preset's, or everything on. */
export function defaultToolset(): Toolset {
  const row = db.prepare("SELECT * FROM presets WHERE is_default = 1 LIMIT 1").get() as PresetRow | undefined;
  return row ? toPreset(row).toolset : EMPTY_TOOLSET;
}

export function savePreset(input: { id?: string; name: string; toolset: unknown; isDefault?: boolean }): Preset {
  const name = String(input.name ?? "").trim();
  if (!name) throw new Error("A preset needs a name.");
  const id = input.id ?? nanoid(10);
  db.transaction(() => {
    // Only one default at a time.
    if (input.isDefault) db.prepare("UPDATE presets SET is_default = 0").run();
    db.prepare(
      `INSERT INTO presets (id, name, toolset, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, toolset = excluded.toolset, is_default = excluded.is_default, updated_at = excluded.updated_at`,
    ).run(id, name, JSON.stringify(normaliseToolset(input.toolset)), input.isDefault ? 1 : 0, now(), now());
  })();
  broadcast("jobs", {});
  return getPreset(id)!;
}

/**
 * Turns one item on or off in the default preset, what a new session gets when
 * nobody chose a toolset. With no default preset yet, one named "Default" is made.
 */
export function setDefaultItem(input: { kind?: unknown; id?: unknown; enabled?: unknown }): Preset {
  const kind = String(input.kind ?? "") as keyof Toolset;
  const id = String(input.id ?? "").trim();
  if (!(kind in EMPTY_TOOLSET) || !id) throw new Error("Send { kind, id, enabled }.");
  const row = db.prepare("SELECT * FROM presets WHERE is_default = 1 LIMIT 1").get() as PresetRow | undefined;
  const preset = row ? toPreset(row) : { id: undefined, name: "Default", toolset: EMPTY_TOOLSET };
  // The toolset lists what is off.
  const off = preset.toolset[kind].filter((item) => item !== id);
  if (input.enabled !== true) off.push(id);
  return savePreset({ id: preset.id, name: preset.name, toolset: { ...preset.toolset, [kind]: off }, isDefault: true });
}

export function deletePreset(id: string): void {
  db.prepare("DELETE FROM presets WHERE id = ?").run(id);
  db.prepare("UPDATE jobs SET preset_id = NULL WHERE preset_id = ?").run(id);
  broadcast("jobs", {});
}
