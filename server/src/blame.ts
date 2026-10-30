import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { FileError, resolvePath } from "./files.js";
import { currentProject } from "./context.js";
import { projectRoot } from "./paths.js";

/**
 * Who last changed each line of a file, from `git blame --porcelain`, for the
 * GitLens-like annotations in the editor. Read-only: git is only asked, never
 * told. Runs without a shell, the path passed as its own argument after "--".
 */
export interface BlameCommit {
  sha: string;
  author: string;
  email: string;
  /** Seconds since the epoch, as git gives it. */
  time: number;
  summary: string;
  /** Lines not committed yet: git reports them under an all-zero hash. */
  uncommitted: boolean;
}

export type BlameResult =
  | { available: true; path: string; head: string; you: string; commits: Record<string, BlameCommit>; lines: string[] }
  | { available: false; path: string; reason: string };

const ZERO = /^0{40}$/;

function git(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: projectRoot(), windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 20_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message).trim().split("\n")[0]));
      else resolve(stdout);
    });
  });
}

/** The blame is cached per file, and thrown away when the file or HEAD moves. */
const cache = new Map<string, { key: string; result: BlameResult }>();

export function parsePorcelain(text: string): { commits: Record<string, BlameCommit>; lines: string[] } {
  const commits: Record<string, BlameCommit> = {};
  const lines: string[] = [];
  let current: BlameCommit | null = null;
  for (const line of text.split("\n")) {
    const header = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/.exec(line);
    if (header) {
      const sha = header[1];
      current = commits[sha] ??= { sha, author: "", email: "", time: 0, summary: "", uncommitted: ZERO.test(sha) };
      lines[Number(header[2]) - 1] = sha;
      continue;
    }
    if (!current || line.startsWith("\t")) continue;
    const space = line.indexOf(" ");
    const key = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? "" : line.slice(space + 1);
    if (key === "author") current.author = value;
    else if (key === "author-mail") current.email = value.replace(/^<|>$/g, "");
    else if (key === "author-time") current.time = Number(value) || 0;
    else if (key === "summary") current.summary = value;
  }
  return { commits, lines };
}

export async function blameFile(relInput: unknown): Promise<BlameResult> {
  const absolute = resolvePath(relInput);
  const rel = path.relative(projectRoot(), absolute).split(path.sep).join("/");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absolute);
  } catch {
    throw new FileError("No such file.", 404);
  }
  if (!stat.isFile()) throw new FileError("That is not a file.");

  let head: string;
  try {
    head = (await git(["rev-parse", "HEAD"])).trim();
  } catch {
    return { available: false, path: rel, reason: "This project is not a git repository, or has no commits yet." };
  }
  const key = `${head}:${stat.mtimeMs}:${stat.size}`;
  const cached = cache.get(`${currentProject().id}:${rel}`);
  if (cached?.key === key) return cached.result;

  let result: BlameResult;
  try {
    const [porcelain, you] = await Promise.all([git(["blame", "--porcelain", "--", rel]), git(["config", "user.name"]).catch(() => "")]);
    result = { available: true, path: rel, head, you: you.trim(), ...parsePorcelain(porcelain) };
  } catch (error) {
    const message = (error as Error).message;
    result = {
      available: false,
      path: rel,
      reason: /no such path|not tracked|untracked/i.test(message) ? "Not committed yet." : /ignored/i.test(message) ? "Ignored by git." : message,
    };
  }
  cache.set(`${currentProject().id}:${rel}`, { key, result });
  return result;
}

/** A commit's full message and date, for the blame hover. */
export async function commitDetails(sha: unknown): Promise<{ sha: string; message: string; author: string; email: string; date: string }> {
  if (typeof sha !== "string" || !/^[0-9a-f]{7,40}$/.test(sha)) throw new FileError("Not a commit hash.");
  const out = await git(["show", "-s", "--format=%H%x00%an%x00%ae%x00%aI%x00%B", sha]).catch((error: Error) => {
    throw new FileError(error.message, 404);
  });
  const [full, author, email, date, message] = out.split("\0");
  return { sha: full, author, email, date, message: (message ?? "").trim() };
}
