import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { allContexts, isGlobal } from "./context.js";
import { renderPrompt } from "./prompts.js";
import { pickNumbers } from "./smallModel.js";

/**
 * Finds a project folder from what a person says ("my calendar app"), for
 * adding a project from a chat, where nobody knows a path by heart. The hub
 * lists the folders that look like projects in the places code usually
 * lives; Claude, with no tools and a small model, picks the ones the words
 * mean. Without Claude, names are matched word by word.
 */

/** What makes a folder a project rather than just a folder. */
const MARKERS = [".git", "package.json", "pyproject.toml", "requirements.txt", "go.mod", "Cargo.toml", "pom.xml", "build.gradle", "composer.json", "Gemfile", "CLAUDE.md", ".claude"];
const PROJECT_FILE = /\.(sln|csproj)$/i;
/** Never looked into: build output, dependencies, and system or app folders. */
const SKIP = new Set(["node_modules", "dist", "build", "out", "bin", "obj", "target", "vendor", "venv", ".venv", "__pycache__", "appdata", "library", "application data", "$recycle.bin", "program files", "program files (x86)", "windows", "programdata"]);
const CODE_DIRS = ["source", "src", "repos", "projects", "code", "dev", "work", "git", "github", "workspace", "documents", "desktop", path.join("source", "repos"), "source code"];

export interface FolderCandidate {
  path: string;
  name: string;
  mtimeMs: number;
}

let cache: { at: number; folders: FolderCandidate[] } | null = null;
const CACHE_MS = 5 * 60_000;

function isProject(dir: string, entries: fs.Dirent[]): boolean {
  return entries.some((entry) => MARKERS.includes(entry.name) || (entry.isFile() && PROJECT_FILE.test(entry.name)));
}

/** Where code lives on this machine: beside the projects already added, and the usual folders. */
function roots(): string[] {
  const home = os.homedir();
  const found = new Set<string>();
  for (const project of allContexts()) {
    if (isGlobal(project)) continue;
    found.add(path.dirname(project.root));
    found.add(path.dirname(path.dirname(project.root)));
  }
  for (const dir of CODE_DIRS) found.add(path.join(home, dir));
  if (process.platform === "win32") {
    for (const letter of "CDEFG") {
      const drive = `${letter}:\\`;
      if (!fs.existsSync(drive)) continue;
      for (const dir of CODE_DIRS) found.add(path.join(drive, dir));
    }
  }
  // As the disk spells them: "C:\source code" typed is "C:\Source code" on disk, and Claude Code names a project's history after that spelling.
  const real = [...found].filter((dir) => dir !== path.parse(dir).root && fs.existsSync(dir)).map((dir) => fs.realpathSync.native(dir));
  return [...new Set(real)];
}

/** The project-looking folders under the roots, three levels deep, newest first; a few seconds at most. */
function scan(): FolderCandidate[] {
  const folders = new Map<string, FolderCandidate>();
  const deadline = Date.now() + 4000;
  let visited = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > 3 || visited > 20_000 || Date.now() > deadline || folders.size > 2000) return;
    visited += 1;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (depth > 0 && isProject(dir, entries)) {
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(dir).mtimeMs;
      } catch {
        // Listed all the same.
      }
      folders.set(dir.toLowerCase(), { path: dir, name: path.basename(dir), mtimeMs });
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP.has(entry.name.toLowerCase())) continue;
      walk(path.join(dir, entry.name), depth + 1);
    }
  };
  for (const root of roots()) walk(root, 0);
  return [...folders.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function candidates(): FolderCandidate[] {
  if (!cache || Date.now() - cache.at > CACHE_MS) cache = { at: Date.now(), folders: scan() };
  // Folders the hub already has are offered through /projects instead.
  const added = new Set(allContexts().map((project) => project.root.toLowerCase()));
  return cache.folders.filter((folder) => !added.has(folder.path.toLowerCase()));
}

/** Without Claude: every word of the request against the folder's path, accents and case aside. */
function matchByName(request: string, folders: FolderCandidate[]): FolderCandidate[] {
  const plain = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const words = plain(request).split(/[^a-z0-9]+/).filter((word) => word.length >= 2);
  const scored = folders
    .map((folder) => {
      const name = plain(folder.name);
      const where = plain(folder.path);
      const score = words.reduce((total, word) => total + (name.includes(word) ? 3 : where.includes(word) ? 1 : 0), 0);
      return { folder, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.folder.mtimeMs - a.folder.mtimeMs);
  return scored.map((item) => item.folder);
}

/** Claude reads the list and the request, and answers with the numbers that fit, best first. */
function askClaude(request: string, folders: FolderCandidate[]): Promise<number[] | null> {
  return pickNumbers(
    renderPrompt("typed.findFolders", {
      request,
      folders: folders.map((folder, index) => `${index + 1}. ${folder.path}`).join("\n"),
    }),
  );
}

/** Up to `limit` folders that fit what the person said, best first; Claude when it can, names otherwise. */
export async function findFolders(request: string, limit = 6): Promise<FolderCandidate[]> {
  // The most recently touched few hundred: enough to find a project, small enough for a quick answer.
  const folders = candidates().slice(0, 400);
  if (!folders.length) return [];
  const picked = await askClaude(request, folders);
  if (picked) {
    const chosen = picked.map((number) => folders[number - 1]).filter((folder): folder is FolderCandidate => Boolean(folder));
    if (chosen.length) return chosen.slice(0, limit);
  }
  return matchByName(request, folders).slice(0, limit);
}
