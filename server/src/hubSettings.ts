import { globalDb, now } from "./db.js";
import { resumeOnStart, setResumeOnStart } from "./resume.js";

/**
 * The hub's own preferences, one set per machine, shown on the global
 * Settings page: whatever browser or phone opens the hub gets the same.
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
}

function flag(key: string, fallback: boolean): boolean {
  const row = globalDb.prepare("SELECT value FROM hub_settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row ? row.value === "1" : fallback;
}

function setFlag(key: string, on: boolean): void {
  globalDb
    .prepare("INSERT INTO hub_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .run(key, on ? "1" : "0", now());
}

export function hubSettings(): HubSettings {
  return { resumeOnStart: resumeOnStart(), confirmStop: flag("confirmStop", true) };
}

export function saveHubSettings(patch: Partial<HubSettings>): HubSettings {
  if (typeof patch.resumeOnStart === "boolean") setResumeOnStart(patch.resumeOnStart);
  if (typeof patch.confirmStop === "boolean") setFlag("confirmStop", patch.confirmStop);
  return hubSettings();
}
