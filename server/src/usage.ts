import * as pty from "@lydell/node-pty";
import headless from "@xterm/headless";
import fs from "node:fs";
import path from "node:path";
import { findClaudeCode } from "./claudeCode.js";
import { hubHome } from "./paths.js";
import { getProfile, listProfiles, profileEnv } from "./profiles.js";
import { childEnv } from "./terminals.js";

/**
 * How much of each account's plan is used, as Claude Code's own /usage shows
 * it. Read from the screen, like the trust dialog (watchdog.ts): a hidden
 * `claude` is started in the hub's folder under the account, /usage is typed,
 * its panel read and the process closed. No model is called and nothing of
 * the account's sign-in is read by the hub. The panel's wording is Claude
 * Code's and may change: what cannot be read is reported, never guessed.
 */

export interface UsageItem {
  /** "Current session", "Current week (all models)", "Usage credits"... as Claude Code names it. */
  label: string;
  percent: number;
  /** The line under the bar without its "Resets": when it resets, and for credits what is spent. */
  detail: string;
}

export interface UsageReading {
  profileId: string;
  at: string;
  items: UsageItem[];
  error: string | null;
}

const COLS = 120;
const ROWS = 80;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const squeeze = (text: string) => text.toLowerCase().replace(/\s+/g, "");

function screenText(screen: InstanceType<typeof headless.Terminal>): string[] {
  const buffer = screen.buffer.active;
  const lines: string[] = [];
  for (let index = 0; index < buffer.length; index += 1) lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
  return lines;
}

/** The bars of the /usage panel: a title line, a bar ending "N% used", then a line saying when it resets. */
export function parseUsage(lines: string[]): UsageItem[] {
  const items: UsageItem[] = [];
  const clean = lines.map((line) => line.trim());
  for (let index = 0; index < clean.length; index += 1) {
    const match = /(\d+(?:\.\d+)?)%\s+used\s*$/.exec(clean[index]);
    if (!match) continue;
    let title = index - 1;
    while (title >= 0 && !clean[title]) title -= 1;
    const label = title >= 0 ? clean[title].replace(/[█▌▐▏▎▍▋▊▉]+/g, "").trim() : "";
    if (!label || /% used/.test(label)) continue;
    const next = clean[index + 1] ?? "";
    const detail = /resets|spent/i.test(next) ? next.replace(/^Resets\s+/i, "resets ") : "";
    items.push({ label, percent: Number(match[1]), detail });
  }
  return items;
}

/** One reading: a hidden claude under the account, /usage typed, its panel read. */
async function probe(profileId: string): Promise<UsageReading> {
  const at = new Date().toISOString();
  const claude = findClaudeCode();
  if (!claude) return { profileId, at, items: [], error: "Claude Code is not installed." };
  // The hub's own folder, as for its other quiet questions to Claude: never a project's.
  const cwd = path.join(hubHome, "global");
  fs.mkdirSync(cwd, { recursive: true });
  const screen = new headless.Terminal({ cols: COLS, rows: ROWS, scrollback: 500, allowProposedApi: true });
  // The classic renderer, so the panel lands in an ordinary buffer whatever the person's tui setting.
  const child = pty.spawn(claude, [], { name: "xterm-256color", cols: COLS, rows: ROWS, cwd, env: { ...childEnv(), ...profileEnv(profileId), CLAUDE_CODE_NO_FLICKER: "0" } });
  child.onData((data) => screen.write(data));
  let exited = false;
  child.onExit(() => (exited = true));
  const until = async (test: (flat: string, lines: string[]) => boolean, ms: number) => {
    const end = Date.now() + ms;
    while (Date.now() < end && !exited) {
      const lines = screenText(screen);
      if (test(squeeze(lines.join("\n")), lines)) return true;
      await sleep(300);
    }
    return false;
  };
  try {
    // Ready: the prompt shows. A trust dialog for the hub's own folder is answered yes: the selection
    // (the line with ❯) is moved onto "Yes, I trust" and confirmed, whatever order this version lists them in.
    let trusted = 0;
    const ready = await until((flat, lines) => {
      if (flat.includes("yes,itrust")) {
        if (trusted < 6) {
          trusted += 1;
          const squeezed = lines.map(squeeze);
          const yes = squeezed.findIndex((line) => line.includes("yes,itrust"));
          const selected = squeezed.findIndex((line) => line.includes("❯"));
          if (yes !== -1 && selected !== -1) child.write(yes === selected ? "\r" : yes > selected ? "\x1b[B" : "\x1b[A");
        }
        return false;
      }
      return flat.includes("❯");
    }, 25_000);
    if (!ready) {
      const flat = squeeze(screenText(screen).join("\n"));
      if (flat.includes("login") || flat.includes("signin")) return { profileId, at, items: [], error: "Not signed in." };
      return { profileId, at, items: [], error: exited ? "Claude Code exited before /usage." : "Claude Code did not get to its prompt." };
    }
    child.write("/usage");
    await sleep(700);
    child.write("\r");
    // The panel is drawn when its bars are; then a moment for the rest of it.
    const shown = await until((_flat, lines) => parseUsage(lines).length > 0, 20_000);
    await sleep(1200);
    const items = parseUsage(screenText(screen));
    if (!shown || !items.length) return { profileId, at, items: [], error: "Could not read /usage; Claude Code may show it differently now." };
    return { profileId, at, items, error: null };
  } finally {
    try {
      child.write("\x1b");
      await sleep(200);
      child.kill();
    } catch {
      // Already gone.
    }
    screen.dispose();
  }
}

const readings = new Map<string, UsageReading>();
const running = new Map<string, Promise<UsageReading>>();
/** A reading this recent is shown as it is, unless asked again. */
const FRESH_MS = 10 * 60_000;

export async function usageOf(profileId: string, fresh = false): Promise<UsageReading> {
  if (!getProfile(profileId)) throw new Error("No such account.");
  const known = readings.get(profileId);
  if (!fresh && known && Date.now() - Date.parse(known.at) < FRESH_MS) return known;
  let pending = running.get(profileId);
  if (!pending) {
    pending = probe(profileId)
      .then((reading) => {
        readings.set(profileId, reading);
        return reading;
      })
      .finally(() => running.delete(profileId));
    running.set(profileId, pending);
  }
  return pending;
}

/** Every account's, one after another so a few hidden claudes do not start at once. */
export async function usageOfAll(fresh = false): Promise<UsageReading[]> {
  const out: UsageReading[] = [];
  for (const profile of listProfiles()) out.push(await usageOf(profile.id, fresh));
  return out;
}
