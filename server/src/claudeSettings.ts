import { db, now } from "./db.js";
import { broadcast } from "./events.js";

/**
 * How the hub starts `claude`: settings for this project's hub, turned into
 * command-line flags on every session it starts. Each one left empty passes no
 * flag, so the user's own Claude Code settings decide. Read at start-up, so a
 * change applies to sessions started afterwards.
 */
export interface ClaudeSettings {
  /** Sessions a person opens: New session and hub tasks. */
  permissionMode: string;
  /** Unattended runs (cron, webhook, the queue). */
  runPermissionMode: string;
  model: string;
  fallbackModel: string;
  effort: string;
  /** Directories outside the project Claude may work in (--add-dir). */
  addDirs: string[];
  /** Claude in Chrome: "on", "off", or "" for the user's own setting. */
  chrome: string;
}

/** What this Claude Code accepts; "default" is the older name of "manual" and still works. */
export const PERMISSION_MODES = ["manual", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions", "default"];
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

const DEFAULTS: ClaudeSettings = {
  permissionMode: "",
  // Runs ask before acting and the questions reach the channels, as agreed for unattended work.
  runPermissionMode: "default",
  model: "",
  fallbackModel: "",
  effort: "",
  addDirs: [],
  chrome: "",
};

export function claudeSettings(): ClaudeSettings {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'claude'").get() as { value: string } | undefined;
  try {
    return { ...DEFAULTS, ...(row ? JSON.parse(row.value) : {}) };
  } catch {
    return DEFAULTS;
  }
}

const word = /^[\w.:\-[\]]*$/;

export function saveClaudeSettings(input: Partial<ClaudeSettings>): ClaudeSettings {
  const next = { ...claudeSettings(), ...input };
  const check = (ok: boolean, message: string) => {
    if (!ok) throw new Error(message);
  };
  check(!next.permissionMode || PERMISSION_MODES.includes(next.permissionMode), `Unknown permission mode '${next.permissionMode}'.`);
  check(!next.runPermissionMode || PERMISSION_MODES.includes(next.runPermissionMode), `Unknown permission mode '${next.runPermissionMode}'.`);
  check(!next.effort || EFFORTS.includes(next.effort), `Effort is one of ${EFFORTS.join(", ")}.`);
  // Model names are aliases ("opus") or full ids ("claude-opus-5-5[1m]"): one word, no spaces.
  check(word.test(next.model) && word.test(next.fallbackModel), "A model is one word, like opus or claude-sonnet-5-5.");
  check(["", "on", "off"].includes(next.chrome), "Claude in Chrome is on, off or your own setting.");
  next.addDirs = (Array.isArray(next.addDirs) ? next.addDirs : []).map((dir) => String(dir).trim()).filter(Boolean);
  db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('claude', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(
    JSON.stringify(next),
    now(),
  );
  broadcast("sessions", {});
  return next;
}

/** The flags these settings add to a session; the permission mode is the caller's, which knows who started it. */
export function settingFlags(settings: ClaudeSettings): string[] {
  const flags: string[] = [];
  if (settings.model) flags.push("--model", settings.model);
  if (settings.fallbackModel) flags.push("--fallback-model", settings.fallbackModel);
  if (settings.effort) flags.push("--effort", settings.effort);
  if (settings.addDirs.length) flags.push("--add-dir", ...settings.addDirs);
  if (settings.chrome === "on") flags.push("--chrome");
  if (settings.chrome === "off") flags.push("--no-chrome");
  return flags;
}

/** Whether sessions are told they may ask for an MCP server (the system.mcp prompt). Off unless turned on. */
export function mcpSuggestionsEnabled(): boolean {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'mcpSuggestions'").get() as { value: string } | undefined;
  return row?.value === "on";
}

export function setMcpSuggestionsEnabled(enabled: boolean): boolean {
  db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('mcpSuggestions', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(
    enabled ? "on" : "off",
    now(),
  );
  broadcast("mcp", {});
  return enabled;
}
