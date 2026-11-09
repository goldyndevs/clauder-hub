import { bindProject, currentProject } from "./context.js";
import { db, globalDb, now } from "./db.js";
import { resumeRun } from "./jobs.js";
import { startSession } from "./sessions.js";
import { terminalForSession } from "./terminals.js";
import { transcriptMtime } from "./transcripts.js";

/**
 * Sessions the hub had running when it stopped come back when it starts.
 *
 * Stopping the hub kills its terminals without marking their sessions ended
 * (terminals.ts `killAll` sets `stopping`), and a crash ends nothing either,
 * so a session whose row still says running or waiting at start-up was live
 * at the end. Read before `recoverRuns` marks them exited; resumed after it.
 * A hand-started session resumes on its terminal; a queued run goes back on
 * the queue, where the project's run limit still holds.
 */

globalDb.exec(`
CREATE TABLE IF NOT EXISTS hub_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`);

/** On unless turned off: the hub's own preference, one per machine. */
export function resumeOnStart(): boolean {
  const row = globalDb.prepare("SELECT value FROM hub_settings WHERE key = 'resumeOnStart'").get() as { value: string } | undefined;
  return row?.value !== "0";
}

export function setResumeOnStart(on: boolean): boolean {
  globalDb
    .prepare("INSERT INTO hub_settings (key, value, updated_at) VALUES ('resumeOnStart', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .run(on ? "1" : "0", now());
  return on;
}

export interface LeftRunning {
  id: string;
  runId: string | null;
}

/** In the current project: the sessions still marked live, from the hub's last life. */
export function leftRunning(): LeftRunning[] {
  return (db.prepare("SELECT id, run_id FROM sessions WHERE status IN ('running', 'waiting')").all() as Array<{ id: string; run_id: string | null }>).map((row) => ({
    id: row.id,
    runId: row.run_id,
  }));
}

/** Resumes them one after another, a moment apart, so a dozen Claude Codes do not start in the same second. */
export function resumeLeftRunning(list: LeftRunning[]): void {
  if (!list.length || !resumeOnStart()) return;
  // Nothing was ever said in it: there is no conversation to pick up.
  const worth = list.filter((item) => transcriptMtime(item.id) > 0);
  if (!worth.length) return;
  console.log(`  resume  : ${currentProject().name}: ${worth.length} session(s) that were running when the hub stopped`);
  worth.forEach((item, index) => {
    setTimeout(
      bindProject(() => {
        try {
          if (terminalForSession(item.id)) return;
          if (item.runId) resumeRun(item.runId);
          else startSession({ resumeId: item.id });
        } catch (error) {
          console.error(`  resume  : ${item.id.slice(0, 8)} could not be resumed: ${(error as Error).message}`);
        }
      }),
      1500 + index * 800,
    );
  });
}
