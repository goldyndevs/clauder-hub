import { execFile } from "node:child_process";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectRoot } from "./paths.js";

/**
 * Small things a developer reaches for while sessions run, per project:
 * where its git checkout stands, and a place for files dropped onto a
 * terminal so their paths can be pasted into it.
 */
export const devRoutes = express.Router();

export interface GitInfo {
  branch: string | null;
  /** Commits not pushed and not pulled; null without an upstream. */
  ahead: number | null;
  behind: number | null;
  staged: number;
  changed: number;
  untracked: number;
  conflicted: number;
  last: { hash: string; subject: string; at: string } | null;
}

function git(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: projectRoot(), windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 10_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message).trim().split("\n")[0]));
      else resolve(stdout);
    });
  });
}

/** Read only: git is asked, never told. Null when the project is not a git checkout. */
export async function gitInfo(): Promise<GitInfo | null> {
  let status: string;
  try {
    status = await git(["status", "--porcelain=v2", "--branch", "--untracked-files=normal"]);
  } catch {
    return null;
  }
  const info: GitInfo = { branch: null, ahead: null, behind: null, staged: 0, changed: 0, untracked: 0, conflicted: 0, last: null };
  for (const line of status.split(/\r?\n/)) {
    if (line.startsWith("# branch.head ")) {
      const head = line.slice("# branch.head ".length);
      info.branch = head === "(detached)" ? null : head;
    } else if (line.startsWith("# branch.ab ")) {
      const match = /\+(\d+) -(\d+)/.exec(line);
      if (match) {
        info.ahead = Number(match[1]);
        info.behind = Number(match[2]);
      }
    } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const xy = line.slice(2, 4);
      if (xy[0] !== ".") info.staged += 1;
      if (xy[1] !== ".") info.changed += 1;
    } else if (line.startsWith("u ")) info.conflicted += 1;
    else if (line.startsWith("? ")) info.untracked += 1;
  }
  try {
    const [hash, at, ...subject] = (await git(["log", "-1", "--format=%h%x00%cI%x00%s"])).trim().split("\0");
    if (hash) info.last = { hash, at, subject: subject.join("\0") };
  } catch {
    // A new repository without a commit yet.
  }
  if (!info.branch) {
    try {
      info.branch = `detached at ${(await git(["rev-parse", "--short", "HEAD"])).trim()}`;
    } catch {
      // No HEAD yet.
    }
  }
  return info;
}

devRoutes.get("/git", async (_req, res) => {
  try {
    res.json({ git: await gitInfo() });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

/** Where dropped files land: the system temp folder, where Claude can read them like a pasted screenshot. */
const DROPS = path.join(os.tmpdir(), "clauder-hub-drops");

/** A file dropped on a terminal: saved as it came, its path sent back to be pasted. */
devRoutes.post("/drop", express.raw({ type: () => true, limit: "100mb" }), (req, res) => {
  const site = req.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return void res.status(403).json({ error: "Not from this page." });
  let name = "file";
  try {
    name = decodeURIComponent(req.get("x-file-name") ?? "file");
  } catch {
    // Taken as the default.
  }
  // Only the base name, without characters Windows refuses.
  const safe = path.basename(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 120) || "file";
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  try {
    const folder = path.join(DROPS, new Date().toISOString().replace(/[:.]/g, "-"));
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, safe);
    fs.writeFileSync(file, body);
    res.json({ path: file });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});
