import { globalDb, now } from "./db.js";

/**
 * The hub's own preferences, one set per machine, shown on the global
 * Settings page: whatever browser or phone opens the hub gets the same.
 * Kept in `hub_settings`, which resume.ts reads for resumeOnStart too.
 */
globalDb.exec(`
CREATE TABLE IF NOT EXISTS hub_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`);

export interface HubSettings {
  /** Sessions running when the hub stops come back when it starts (resume.ts). */
  resumeOnStart: boolean;
  /** Stopping a session asks first. */
  confirmStop: boolean;
  /**
   * Sessions use Claude Code's fullscreen renderer (CLAUDE_CODE_NO_FLICKER=1):
   * clicks move the cursor and the wheel scrolls in Claude. Off leaves it to
   * Claude Code's own setting, which it may turn off by itself.
   */
  fullscreen: boolean;
}

function flag(key: string, fallback: boolean): boolean {
  const row = globalDb.prepare("SELECT value FROM hub_settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row ? row.value !== "0" : fallback;
}

function setFlag(key: string, on: boolean): void {
  globalDb
    .prepare("INSERT INTO hub_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .run(key, on ? "1" : "0", now());
}

export function hubSettings(): HubSettings {
  return { resumeOnStart: flag("resumeOnStart", true), confirmStop: flag("confirmStop", true), fullscreen: flag("fullscreen", false) };
}

export function saveHubSettings(patch: Partial<HubSettings>): HubSettings {
  for (const key of ["resumeOnStart", "confirmStop", "fullscreen"] as const) {
    if (typeof patch[key] === "boolean") setFlag(key, patch[key]);
  }
  return hubSettings();
}

/** What a new session's environment gets from these settings. */
export function sessionEnvFromSettings(): Record<string, string> {
  return flag("fullscreen", false) ? { CLAUDE_CODE_NO_FLICKER: "1" } : {};
}
