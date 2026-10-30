import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeHome, projectRoot, transcriptsDir } from "./paths.js";

/**
 * What this project's sessions can reach for: agents, skills, commands, MCP
 * servers, hooks and plugins, from every scope Claude Code reads them from.
 * Read-only: the hub never installs anything here except an MCP the user asked
 * it to run the command for.
 */

export type Scope = "user" | "project" | "local" | "plugin" | "built-in";

/**
 * Subagents that ship inside Claude Code, which no file lists. The set is
 * Claude Code's, so it can drift between versions; this is what 2.1.x offers
 * besides the "fork" mode and the catch-all default agent.
 */
const BUILT_IN_AGENTS: Array<[string, string]> = [
  ["Explore", "Fast read-only search across the codebase."],
  ["Plan", "Designs an implementation plan."],
  ["general-purpose", "Multi-step research, code search and tasks."],
  ["claude-code-guide", "Answers questions about Claude Code, the Agent SDK and the API."],
  ["statusline-setup", "Configures the status line."],
  ["web-fetch", "Fetches and reads web pages."],
];

export interface DefinitionItem {
  name: string;
  description: string;
  scope: Scope;
  /** The plugin it came with, for scope = plugin. */
  plugin?: string;
  path: string;
  model?: string;
}

export interface McpServerItem {
  name: string;
  scope: Scope;
  plugin?: string;
  transport: string;
  /** Command line or URL, never headers or env values: those carry secrets. */
  target: string;
  source: string;
  disabled?: boolean;
}

export interface HookItem {
  event: string;
  matcher: string;
  type: string;
  scope: Scope;
  plugin?: string;
  source: string;
  summary: string;
}

export interface PluginItem {
  id: string;
  version: string;
  scope: string;
  enabled: boolean;
  path: string;
}

export interface Inventory {
  agents: DefinitionItem[];
  skills: DefinitionItem[];
  commands: DefinitionItem[];
  mcpServers: McpServerItem[];
  hooks: HookItem[];
  plugins: PluginItem[];
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** The YAML front matter of an agent, skill or command: flat keys only, which is all they use. */
export function frontMatter(text: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return {};
  const fields: Record<string, string> = {};
  let lastKey = "";
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (pair) {
      lastKey = pair[1];
      fields[lastKey] = pair[2].replace(/^["']|["']$/g, "").replace(/^[>|]-?$/, "");
    } else if (lastKey && /^\s+\S/.test(line)) {
      // A folded or indented continuation of the previous value.
      fields[lastKey] = `${fields[lastKey]} ${line.trim()}`.trim();
    }
  }
  return fields;
}

function definition(file: string, fallbackName: string, scope: Scope, plugin?: string): DefinitionItem | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const meta = frontMatter(text);
  const name = meta.name || fallbackName;
  return {
    name: plugin ? `${plugin.split("@")[0]}:${name}` : name,
    description: meta.description ?? "",
    scope,
    plugin,
    path: file,
    model: meta.model || undefined,
  };
}

function markdownFiles(dir: string, depth = 3): string[] {
  const found: string[] = [];
  const walk = (current: string, left: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory() && left > 0) walk(full, left - 1);
      else if (entry.isFile() && entry.name.endsWith(".md")) found.push(full);
    }
  };
  walk(dir, depth);
  return found;
}

function agentsIn(dir: string, scope: Scope, plugin?: string): DefinitionItem[] {
  return markdownFiles(dir, 1)
    .map((file) => definition(file, path.basename(file, ".md"), scope, plugin))
    .filter((item): item is DefinitionItem => item !== null);
}

function skillsIn(dir: string, scope: Scope, plugin?: string): DefinitionItem[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => definition(path.join(dir, entry.name, "SKILL.md"), entry.name, scope, plugin))
    .filter((item): item is DefinitionItem => item !== null);
}

function commandsIn(dir: string, scope: Scope, plugin?: string): DefinitionItem[] {
  return markdownFiles(dir, 2)
    .map((file) => definition(file, path.relative(dir, file).replace(/\.md$/, "").replace(/[\\/]/g, ":"), scope, plugin))
    .filter((item): item is DefinitionItem => item !== null);
}

function mcpFrom(servers: unknown, scope: Scope, source: string, plugin?: string): McpServerItem[] {
  if (!servers || typeof servers !== "object") return [];
  return Object.entries(servers as Record<string, any>).map(([name, config]) => ({
    name: plugin ? `plugin:${plugin.split("@")[0]}:${name}` : name,
    scope,
    plugin,
    transport: String(config?.type ?? (config?.url ? "http" : "stdio")),
    target: config?.url ? String(config.url) : [config?.command, ...(Array.isArray(config?.args) ? config.args : [])].filter(Boolean).join(" "),
    source,
  }));
}

function hooksFrom(settings: any, scope: Scope, source: string, plugin?: string): HookItem[] {
  const hooks = settings?.hooks;
  if (!hooks || typeof hooks !== "object") return [];
  const items: HookItem[] = [];
  for (const [event, groups] of Object.entries(hooks as Record<string, any[]>)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      for (const hook of Array.isArray(group?.hooks) ? group.hooks : []) {
        items.push({
          event,
          matcher: String(group?.matcher ?? ""),
          type: String(hook?.type ?? "command"),
          scope,
          plugin,
          source,
          summary: String(hook?.command ?? hook?.url ?? hook?.prompt ?? hook?.tool ?? "").slice(0, 200),
        });
      }
    }
  }
  return items;
}

/** ~/.claude.json keys projects by path with forward slashes; older versions used backslashes. */
function localProjectConfig(global: any): any {
  const projects = global?.projects ?? {};
  const wanted = [projectRoot(), projectRoot().replace(/\\/g, "/")];
  for (const [key, value] of Object.entries(projects)) {
    if (wanted.some((candidate) => candidate.toLowerCase() === key.toLowerCase())) return value;
  }
  return null;
}

export function readInventory(): Inventory {
  const userSettingsFile = path.join(claudeHome, "settings.json");
  const projectSettingsFile = path.join(projectRoot(), ".claude", "settings.json");
  const localSettingsFile = path.join(projectRoot(), ".claude", "settings.local.json");
  const userSettings = readJson(userSettingsFile);
  const projectSettings = readJson(projectSettingsFile);
  const localSettings = readJson(localSettingsFile);
  const globalConfigFile = path.join(os.homedir(), ".claude.json");
  const globalConfig = readJson(globalConfigFile);
  const local = localProjectConfig(globalConfig);

  const enabled: Record<string, boolean> = {
    ...(userSettings?.enabledPlugins ?? {}),
    ...(projectSettings?.enabledPlugins ?? {}),
    ...(localSettings?.enabledPlugins ?? {}),
  };

  const plugins: PluginItem[] = [];
  const installed = readJson(path.join(claudeHome, "plugins", "installed_plugins.json"));
  for (const [id, installs] of Object.entries((installed?.plugins ?? {}) as Record<string, any[]>)) {
    const install = Array.isArray(installs) ? installs[installs.length - 1] : null;
    if (!install?.installPath) continue;
    plugins.push({
      id,
      version: String(install.version ?? ""),
      scope: String(install.scope ?? "user"),
      // Installed plugins are on unless a settings file turns them off.
      enabled: enabled[id] !== false,
      path: install.installPath,
    });
  }

  const agents: DefinitionItem[] = [
    ...agentsIn(path.join(claudeHome, "agents"), "user"),
    ...agentsIn(path.join(projectRoot(), ".claude", "agents"), "project"),
    // No file behind these, so no path: they can be turned off, not edited.
    ...BUILT_IN_AGENTS.map(([name, description]) => ({ name, description, scope: "built-in" as const, path: "" })),
  ];
  const skills = [...skillsIn(path.join(claudeHome, "skills"), "user"), ...skillsIn(path.join(projectRoot(), ".claude", "skills"), "project")];
  const commands = [
    ...commandsIn(path.join(claudeHome, "commands"), "user"),
    ...commandsIn(path.join(projectRoot(), ".claude", "commands"), "project"),
  ];
  const disabledJson = new Set<string>(local?.disabledMcpjsonServers ?? []);
  const mcpServers = [
    ...mcpFrom(globalConfig?.mcpServers, "user", globalConfigFile),
    ...mcpFrom(local?.mcpServers, "local", globalConfigFile),
    ...mcpFrom(readJson(path.join(projectRoot(), ".mcp.json"))?.mcpServers, "project", path.join(projectRoot(), ".mcp.json")).map(
      (server) => ({ ...server, disabled: disabledJson.has(server.name) }),
    ),
  ];
  const hooks = [
    ...hooksFrom(userSettings, "user", userSettingsFile),
    ...hooksFrom(projectSettings, "project", projectSettingsFile),
    ...hooksFrom(localSettings, "local", localSettingsFile),
  ];

  for (const plugin of plugins.filter((item) => item.enabled)) {
    agents.push(...agentsIn(path.join(plugin.path, "agents"), "plugin", plugin.id));
    skills.push(...skillsIn(path.join(plugin.path, "skills"), "plugin", plugin.id));
    commands.push(...commandsIn(path.join(plugin.path, "commands"), "plugin", plugin.id));
    const pluginMcp = readJson(path.join(plugin.path, ".mcp.json"));
    mcpServers.push(...mcpFrom(pluginMcp?.mcpServers ?? pluginMcp, "plugin", path.join(plugin.path, ".mcp.json"), plugin.id));
    hooks.push(...hooksFrom(readJson(path.join(plugin.path, "hooks", "hooks.json")), "plugin", path.join(plugin.path, "hooks", "hooks.json"), plugin.id));
  }

  return { agents, skills, commands, mcpServers, hooks, plugins };
}

/**
 * The instruction files Claude Code loads into every session of this project,
 * plus the agent and skill definitions, which are prompts too. These are the
 * only files the hub will write for the user.
 */
export interface MemoryFile {
  path: string;
  label: string;
  group: "memory" | "rules" | "auto-memory" | "agent" | "skill" | "command";
  scope: Scope;
  exists: boolean;
}

export function memoryFiles(): MemoryFile[] {
  const files: MemoryFile[] = [];
  const add = (file: string, label: string, group: MemoryFile["group"], scope: Scope, always = false) => {
    const exists = fs.existsSync(file);
    if (exists || always) files.push({ path: file, label, group, scope, exists });
  };
  add(path.join(claudeHome, "CLAUDE.md"), "~/.claude/CLAUDE.md", "memory", "user", true);
  add(path.join(projectRoot(), "CLAUDE.md"), "CLAUDE.md", "memory", "project", true);
  add(path.join(projectRoot(), ".claude", "CLAUDE.md"), ".claude/CLAUDE.md", "memory", "project");
  add(path.join(projectRoot(), "CLAUDE.local.md"), "CLAUDE.local.md", "memory", "local");
  for (const file of markdownFiles(path.join(claudeHome, "rules"))) add(file, `~/.claude/rules/${path.relative(path.join(claudeHome, "rules"), file)}`, "rules", "user");
  for (const file of markdownFiles(path.join(projectRoot(), ".claude", "rules"))) add(file, `.claude/rules/${path.relative(path.join(projectRoot(), ".claude", "rules"), file)}`, "rules", "project");
  for (const file of markdownFiles(path.join(transcriptsDir(), "memory"), 1)) add(file, `memory/${path.basename(file)}`, "auto-memory", "local");

  const inventory = readInventory();
  for (const agent of inventory.agents.filter((item) => item.scope !== "plugin" && item.path)) add(agent.path, `agent: ${agent.name}`, "agent", agent.scope);
  for (const skill of inventory.skills.filter((item) => item.scope !== "plugin")) add(skill.path, `skill: ${skill.name}`, "skill", skill.scope);
  for (const command of inventory.commands.filter((item) => item.scope !== "plugin")) add(command.path, `command: /${command.name}`, "command", command.scope);
  return files.map((file) => ({ ...file, label: file.label.replace(/\\/g, "/") }));
}

/** Only a file the list above names may be read or written through the API. */
export function isMemoryFile(file: string): boolean {
  const wanted = path.resolve(file).toLowerCase();
  return memoryFiles().some((item) => path.resolve(item.path).toLowerCase() === wanted);
}

/** Any agent, skill or command definition, plugins' included: readable, but only the ones above are writable. */
export function isDefinitionFile(file: string): boolean {
  const wanted = path.resolve(file).toLowerCase();
  const inventory = readInventory();
  return [...inventory.agents, ...inventory.skills, ...inventory.commands].some((item) => item.path && path.resolve(item.path).toLowerCase() === wanted);
}
