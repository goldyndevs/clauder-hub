import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * The `claude` the user already runs, never a copy of our own. On Windows the
 * one on PATH is a `.cmd` shim, which a pty cannot exec directly, so the real
 * executable is looked up behind it.
 */
const BINARY = process.platform === "win32" ? "claude.exe" : "claude";

const KNOWN_LOCATIONS = [
  `${process.env.APPDATA ?? ""}/npm/node_modules/@anthropic-ai/claude-code/bin`,
  `${process.env.LOCALAPPDATA ?? ""}/npm/node_modules/@anthropic-ai/claude-code/bin`,
  `${process.env.USERPROFILE ?? process.env.HOME ?? ""}/.local/bin`,
  "/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin",
  "/usr/lib/node_modules/@anthropic-ai/claude-code/bin",
  "/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin",
  "/usr/local/bin",
];

function fromKnown(): string | null {
  for (const directory of KNOWN_LOCATIONS) {
    // An unset variable leaves "/npm/..." behind, which is nobody's install.
    if (directory.startsWith("/npm") || directory.startsWith("/.local")) continue;
    const candidate = path.join(directory, BINARY);
    if (fs.existsSync(candidate)) return path.normalize(candidate);
  }
  return null;
}

function fromNpmRoot(): string | null {
  try {
    const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8", shell: true, windowsHide: true }).trim();
    const candidate = path.join(root, "@anthropic-ai", "claude-code", "bin", BINARY);
    return fs.existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

/** A native install puts the real binary straight on PATH. */
function fromPath(): string | null {
  try {
    const finder = process.platform === "win32" ? "where" : "which";
    const hits = execFileSync(finder, [BINARY], { encoding: "utf8", windowsHide: true }).split(/\r?\n/);
    return hits.map((hit) => hit.trim()).find((hit) => hit && fs.existsSync(hit)) ?? null;
  } catch {
    return null;
  }
}

let cached: string | null | undefined;
let missingSince = 0;

/** Found once, kept; not found, looked for again after a while, so installing it needs no restart. */
export function findClaudeCode(): string | null {
  if (cached || (cached === null && Date.now() - missingSince < 30_000)) return cached;
  cached = process.env.CLAUDER_HUB_CLAUDE || (fromKnown() ?? fromPath() ?? fromNpmRoot());
  if (cached && !fs.existsSync(cached)) cached = null;
  if (!cached) missingSince = Date.now();
  return cached;
}

/**
 * Whether Claude Code can do anything here: installed, runs, signed in.
 * `problem` is what stops it, `fix` what to type about it. Signed in is
 * unknown (null) when `claude auth status` does not answer in JSON, and then
 * nothing is refused for it.
 */
export interface ClaudeStatus {
  path: string | null;
  version: string | null;
  loggedIn: boolean | null;
  account: string | null;
  problem: "missing" | "broken" | "signedOut" | null;
  message: string | null;
  fix: string | null;
  checkedAt: number;
}

const run = (file: string, args: string[]) =>
  new Promise<{ ok: boolean; out: string }>((resolve) => {
    try {
      // A .cmd shim (CLAUDER_HUB_CLAUDE may name one) only runs through the shell.
      const shell = /\.(cmd|bat)$/i.test(file);
      execFile(shell ? `"${file}"` : file, args, { encoding: "utf8", windowsHide: true, timeout: 20_000, shell }, (error, stdout) => resolve({ ok: !error, out: String(stdout ?? "") }));
    } catch {
      // Not something that runs at all (a broken install): spawn throws before any callback.
      resolve({ ok: false, out: "" });
    }
  });

let status: ClaudeStatus | null = null;
let checking: Promise<ClaudeStatus> | null = null;

async function check(): Promise<ClaudeStatus> {
  cached = undefined;
  const found = findClaudeCode();
  const base = { path: found, version: null, loggedIn: null, account: null, checkedAt: Date.now() };
  if (!found) {
    return { ...base, problem: "missing", message: "Claude Code is not installed on this machine.", fix: "npm i -g @anthropic-ai/claude-code" };
  }
  const version = await run(found, ["--version"]);
  if (!version.ok) {
    return { ...base, problem: "broken", message: `Claude Code at ${found} does not start.`, fix: "npm i -g @anthropic-ai/claude-code" };
  }
  const auth = await run(found, ["auth", "status"]);
  let loggedIn: boolean | null = null;
  let account: string | null = null;
  try {
    const parsed = JSON.parse(auth.out) as { loggedIn?: boolean; email?: string; authMethod?: string };
    if (typeof parsed.loggedIn === "boolean") loggedIn = parsed.loggedIn;
    account = parsed.email ?? parsed.authMethod ?? null;
  } catch {
    // An older Claude Code without the command: whether it is signed in is left unknown.
  }
  const signedOut = loggedIn === false;
  return {
    ...base,
    version: version.out.trim().split(/\s/)[0] || null,
    loggedIn,
    account,
    problem: signedOut ? "signedOut" : null,
    message: signedOut ? "Claude Code is installed but not signed in." : null,
    fix: signedOut ? "claude auth login" : null,
  };
}

/** Checks again (a few seconds), sharing a check already under way. */
export function checkClaudeCode(): Promise<ClaudeStatus> {
  checking ??= check()
    .then((result) => (status = result))
    .finally(() => (checking = null));
  return checking;
}

/** The last check, refreshed in the background once it is a few minutes old. */
export function claudeStatus(): ClaudeStatus | null {
  if (!status || Date.now() - status.checkedAt > 5 * 60_000) void checkClaudeCode();
  return status;
}

/** Thrown when a session cannot start because of Claude Code itself; the message says what to do. */
export class ClaudeMissing extends Error {}

/** Refuses to start a session that could only fail: Claude Code missing, broken, or signed out. */
export function requireClaudeCode(): string {
  const found = findClaudeCode();
  const known = claudeStatus();
  if (!found) throw new ClaudeMissing("Claude Code was not found. Install it with 'npm i -g @anthropic-ai/claude-code' and sign in once with 'claude auth login'.");
  // Fixed since the last check? Looked at again now, so the next try sees it.
  if (known?.problem && Date.now() - known.checkedAt > 10_000) void checkClaudeCode();
  if (known?.problem === "broken" && known.path === found) throw new ClaudeMissing(`${known.message} Reinstall it with '${known.fix}'.`);
  if (known?.problem === "signedOut") throw new ClaudeMissing("Claude Code is not signed in. Run 'claude auth login' on this machine, then try again.");
  return found;
}
