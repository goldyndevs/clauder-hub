import { bindProject } from "./context.js";
import { closeOpen, createInteraction, listInteractions } from "./interactions.js";
import { getSessionRow, setSessionStatus } from "./sessions.js";
import { allTerminals, listTerminals, pressKeys, type Terminal } from "./terminals.js";

/**
 * What a session's hooks cannot report, read from its screen instead.
 *
 * - Claude Code's "Do you trust the files in this folder?" dialog comes before
 *   any hook, so a run would sit on it, shown as running, with nobody told. It
 *   becomes a question (inbox, channels, the session marked waiting): option 1
 *   trusts, option 2 exits, typed into the dialog like any other answer.
 * - A run whose screen has not changed for a while has stopped moving: a dialog
 *   the hub does not know, or a turn that ended without its done block. Claude
 *   working shows a ticking spinner, so silence means it waits. It is reported
 *   once per quiet spell, with the screen's last lines, and a reply goes in as
 *   the next message.
 */

const TRUST_MARKERS = ["doyoutrustthefilesinthisfolder", "isthisaprojectyoucreatedoroneyoutrust", "yes,itrustthisfolder"];
/** Quiet long enough to call a run stuck: well past any pause between Claude's own redraws. */
const STALL_MS = Number(process.env.CLAUDER_HUB_STALL_MS) || 8 * 60_000;
const SCREEN_TAIL = 8000;

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>78]/g;

/** The end of what the terminal printed, without escape codes. */
function screenTail(terminal: Terminal): string {
  let text = "";
  for (let index = terminal.backlog.length - 1; index >= 0 && text.length < SCREEN_TAIL * 2; index -= 1) text = terminal.backlog[index] + text;
  return text.slice(-SCREEN_TAIL * 2).replace(ANSI, "").slice(-SCREEN_TAIL);
}

/** The TUI places words with cursor moves, so spacing is unreliable: compare without any. */
const squeeze = (text: string) => text.toLowerCase().replace(/\s+/g, "");
/**
 * Showing now, not merely printed earlier: the dialog's text is there and the
 * last thing printed is still the dialog (its options or "Enter to confirm"),
 * so a dialog just answered and being replaced does not count again.
 */
const showsTrustDialog = (screen: string) => {
  const flat = squeeze(screen.slice(-3000));
  if (!TRUST_MARKERS.some((marker) => flat.includes(marker))) return false;
  const end = Math.max(flat.lastIndexOf("entertoconfirm"), flat.lastIndexOf("itrustthisfolder"), flat.lastIndexOf("no,exit"));
  return end >= 0 && flat.length - end < 120;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Answers the trust dialog. Its options carry no numbers and their order and
 * default differ between Claude Code versions ("No, exit" first and selected
 * in some), so the selection is read off the screen: arrows move it onto the
 * wanted option, then Enter confirms. Declining is Escape, which exits.
 */
export async function answerTrust(terminal: Terminal, trust: boolean): Promise<void> {
  if (!trust) return pressKeys(terminal, "\x1b");
  for (let step = 0; step < 4; step += 1) {
    const flat = squeeze(screenTail(terminal).slice(-1500));
    const cursor = flat.lastIndexOf("❯");
    const after = cursor >= 0 ? flat.slice(cursor + 1) : "";
    if (after.startsWith("yes")) return pressKeys(terminal, "\r");
    // Below the cursor means down, else up.
    const yesAt = flat.lastIndexOf("yes,itrust");
    await pressKeys(terminal, yesAt > cursor ? "\x1b[B" : "\x1b[A");
    await sleep(300);
  }
  throw new Error("Could not find the trust option on the screen.");
}

/** The last lines worth reading, for a person deciding what a stuck run needs. */
function lastLines(screen: string): string {
  const lines = screen.split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  return lines.slice(-14).join("\n").slice(-1200);
}

/** The quiet spell each terminal was last reported for, so it is reported once. */
const reported = new Map<string, number>();

function check(): void {
  for (const terminal of listTerminals()) {
    if (terminal.finished || terminal.restarting) continue;
    const open = listInteractions({ sessionId: terminal.sessionId, status: "open" });
    const screen = screenTail(terminal);
    const trustOpen = open.find((item) => item.data?.trust);

    if (showsTrustDialog(screen)) {
      if (!trustOpen) {
        createInteraction({
          sessionId: terminal.sessionId,
          kind: "question",
          title: "Trust this folder?",
          body: "Claude Code asks whether to trust the files in this project's folder before it starts. Nothing runs until it is answered.",
          options: [
            { key: "1", label: "Yes, trust this folder" },
            { key: "2", label: "No, exit" },
          ],
          data: { trust: true, questions: [{ question: "Trust this folder?", options: ["Yes, trust this folder", "No, exit"] }] },
        });
      }
      continue;
    }
    // Answered at the keyboard: the dialog has gone from the screen.
    if (trustOpen) closeOpen(terminal.sessionId, "terminal", ["question"]);

    // A stuck report the run has since moved past on its own (its screen changed again).
    const stalled = open.find((item) => item.data?.stalled);
    if (stalled && terminal.lastOutputAt > Date.parse(stalled.createdAt) + 5000) {
      closeOpen(terminal.sessionId, "terminal", ["turn"]);
      setSessionStatus(terminal.sessionId, "running");
      continue;
    }

    // Only unattended runs: a person at an interactive session can see it.
    const quietFor = Date.now() - terminal.lastOutputAt;
    if (quietFor < STALL_MS || open.length || reported.get(terminal.id) === terminal.lastOutputAt) continue;
    if (!getSessionRow(terminal.sessionId)?.run_id) continue;
    reported.set(terminal.id, terminal.lastOutputAt);
    createInteraction({
      sessionId: terminal.sessionId,
      kind: "turn",
      title: "This run looks stuck",
      body: `Nothing has changed on its screen for ${Math.round(quietFor / 60_000)} minutes. It may be waiting on a dialog, or it stopped without reporting done. Reply to type into it, or stop it.\n\n${lastLines(screen)}`,
      data: { stalled: true },
    });
  }
  // Every project's terminals: this map is shared, and each project checks only its own.
  for (const id of reported.keys()) if (!allTerminals().some((terminal) => terminal.id === id)) reported.delete(id);
}

/** Watches the current project's terminals; returns the stop function. */
export function startWatchdog(intervalMs = 3000): () => void {
  const timer = setInterval(bindProject(() => {
    try {
      check();
    } catch (error) {
      console.error("[watchdog]", (error as Error).message);
    }
  }), intervalMs);
  return () => clearInterval(timer);
}
