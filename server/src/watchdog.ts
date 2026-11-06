import { bindProject } from "./context.js";
import { broadcast } from "./events.js";
import { closeOpen, createInteraction, listInteractions } from "./interactions.js";
import { getSessionRow, setSessionStatus } from "./sessions.js";
import { allTerminals, listTerminals, pressKeys, screenLines, type Terminal } from "./terminals.js";

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
/** Compared without spaces or case: the dialog's wording and padding vary a little between versions. */
const squeeze = (text: string) => text.toLowerCase().replace(/\s+/g, "");
/**
 * On the screen now, read from the hub's own copy of it (terminals.ts), so a
 * dialog printed earlier and since replaced does not count: its question and
 * one of its options are both showing.
 */
const showsTrustDialog = (lines: string[]) => {
  const flat = squeeze(lines.join("\n"));
  return TRUST_MARKERS.some((marker) => flat.includes(marker)) && (flat.includes("itrustthisfolder") || flat.includes("no,exit"));
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Answers the trust dialog. Its options carry no numbers and their order and
 * default differ between Claude Code versions ("No, exit" first and selected
 * in some), so the selection is read off the screen's lines: the line with
 * the ❯ is the selected one, arrows move it onto "Yes, I trust", then Enter
 * confirms. Declining is Escape, which exits.
 */
export async function answerTrust(terminal: Terminal, trust: boolean): Promise<void> {
  if (!trust) return pressKeys(terminal, "\x1b");
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const lines = (await screenLines(terminal)).map(squeeze);
    const yes = lines.findIndex((line) => line.includes("yes,itrust"));
    const selected = lines.findIndex((line) => line.includes("❯"));
    if (yes === -1 || selected === -1) throw new Error("Could not find the trust dialog on the screen; answer it in the terminal.");
    if (yes === selected) return pressKeys(terminal, "\r");
    // One arrow per line between them, each its own key press: down when "Yes" is below the selection.
    const arrow = yes > selected ? "\x1b[B" : "\x1b[A";
    await pressKeys(terminal, ...Array<string>(Math.abs(yes - selected)).fill(arrow));
    await sleep(300);
  }
  throw new Error('Could not move the selection onto "Yes, I trust this folder"; answer it in the terminal.');
}

/** The last lines worth reading, for a person deciding what a stuck run needs. */
function lastLines(screen: string): string {
  const lines = screen.split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  return lines.slice(-14).join("\n").slice(-1200);
}

/** The quiet spell each terminal was last reported for, so it is reported once. */
const reported = new Map<string, number>();

async function check(): Promise<void> {
  for (const terminal of listTerminals()) {
    if (terminal.finished || terminal.restarting) continue;
    const open = listInteractions({ sessionId: terminal.sessionId, status: "open" });
    const screen = await screenLines(terminal);
    // Working or idle at its prompt: Claude Code shows "esc to interrupt" only while a turn runs.
    const busy = squeeze(screen.join("\n")).includes("esctointerrupt");
    if (terminal.busy !== busy) {
      terminal.busy = busy;
      broadcast("sessions", { sessionId: terminal.sessionId });
    }
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
      body: `Nothing has changed on its screen for ${Math.round(quietFor / 60_000)} minutes. It may be waiting on a dialog, or it stopped without reporting done. Reply to type into it, or stop it.\n\n${lastLines(screen.join("\n"))}`,
      data: { stalled: true },
    });
  }
  // Every project's terminals: this map is shared, and each project checks only its own.
  for (const id of reported.keys()) if (!allTerminals().some((terminal) => terminal.id === id)) reported.delete(id);
}

/** Watches the current project's terminals; returns the stop function. */
export function startWatchdog(intervalMs = 3000): () => void {
  let busy = false;
  const timer = setInterval(bindProject(() => {
    if (busy) return;
    busy = true;
    check()
      .catch((error) => console.error("[watchdog]", (error as Error).message))
      .finally(() => (busy = false));
  }), intervalMs);
  return () => clearInterval(timer);
}
