#!/usr/bin/env node
import cors from "cors";
import express from "express";
import fs from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { checkClaudeCode, findClaudeCode } from "./claudeCode.js";
import { withProject } from "./context.js";
import { globalDb } from "./db.js";
import { fileRoutes } from "./fileRoutes.js";
import { watchRunExits } from "./jobs.js";
import { ensureLayout, hubHome } from "./paths.js";
import { addProject, bootGlobal, bootProjects, getProject, listProjects, stopProjects } from "./projects.js";
import { api, hubApi } from "./routes.js";
import { cleanRunFiles, setHubPort } from "./sessions.js";
import { attachClient, getTerminal, killAll, onTerminalExit } from "./terminals.js";

const port = Number(process.env.PORT ?? 4329);
/** A folder given on the command line: added to the hub, and opened. */
const requested = process.env.CLAUDER_HUB_PROJECT;

ensureLayout();

/**
 * One hub per machine: every project's cron jobs and queue run in it, so a
 * second one would run them twice. Starting the hub while one runs hands the
 * folder to it instead, and says where the dashboard is.
 */
const lockFile = path.join(hubHome, "hub.lock");
type Lock = { pid: number; port: number | null };
const readLock = (): Lock | null => {
  try {
    return JSON.parse(fs.readFileSync(lockFile, "utf8")) as Lock;
  } catch {
    return null;
  }
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** Created exclusively, so of two hubs starting at once only one gets it; a lock left by a dead process is taken over. */
function takeLock(): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, port: null }), { flag: "wx" });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const lock = readLock();
      if (lock && alive(lock.pid)) return false;
      fs.rmSync(lockFile, { force: true });
    }
  }
  return false;
}
/** The running hub's port, once it answers as a hub; it may still be starting, so it is given a little while. */
async function otherHubPort(): Promise<number | null> {
  for (let tries = 0; tries < 20; tries++) {
    const lock = readLock();
    if (!lock || !alive(lock.pid)) return null;
    if (lock.port) {
      try {
        const response = await fetch(`http://127.0.0.1:${lock.port}/api/hub`, { signal: AbortSignal.timeout(5000) });
        const body = (await response.json()) as { version?: unknown };
        if (response.ok && "version" in body) return lock.port;
      } catch {
        // Busy or still starting: asked again below.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}
// A hub that was stopping as this one started (a reload) has let go of the lock by the time it was waited for.
if (!takeLock() && !(await otherHubPort().then((found) => found === null && takeLock()))) {
  const otherPort = await otherHubPort();
  if (!otherPort) {
    console.error(`\n  Another Clauder Hub (pid ${readLock()?.pid}) holds ${lockFile} but does not answer. Stop it, or delete the file if it is gone.\n`);
    process.exit(1);
  }
  let route = "";
  if (requested) {
    const response = await fetch(`http://127.0.0.1:${otherPort}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: requested }),
    });
    const added = (await response.json().catch(() => ({}))) as { id?: string; error?: string };
    if (!response.ok || !added.id) {
      console.error(`\n  ${added.error ?? "The running hub did not take the folder."}\n`);
      process.exit(1);
    }
    route = `/#/${added.id}`;
  }
  console.log(`\n  Clauder Hub is already running: http://localhost:${otherPort}${route}\n`);
  process.exit(0);
}
/** The lock goes with this process, and only if it is still this process's. */
const releaseLock = () => {
  if (readLock()?.pid === process.pid) fs.rmSync(lockFile, { force: true });
};

const app = express();
// Production is same-origin. Dev uses Vite on the adjacent local port; no
// other web page may drive this process through the user's browser.
const webPort = process.env.WEB_PORT ?? "4328";
function allowedOrigin(origin: string | undefined, host: string): boolean {
  if (!origin) return true;
  try {
    const source = new URL(origin);
    const localHost = source.hostname === "localhost" || source.hostname === "127.0.0.1";
    const devOrigin = Boolean(process.env.CLAUDER_HUB_DEV) && localHost && source.port === webPort;
    return localHost && (source.host === host || devOrigin);
  } catch {
    return false;
  }
}
app.use((req, res, next) => {
  if (allowedOrigin(req.get("origin"), req.get("host") ?? "")) return next();
  res.status(403).json({ error: "Origin is not allowed." });
});
if (process.env.CLAUDER_HUB_DEV) {
  const allowed = new Set([`http://localhost:${webPort}`, `http://127.0.0.1:${webPort}`]);
  app.use(cors({ origin: (origin, callback) => callback(null, !origin || allowed.has(origin)) }));
}
app.use(express.json({ limit: "10mb" }));

/** /api/p/<project id>/...: everything below runs in that project (see context.ts). */
const scoped = express.Router({ mergeParams: true });
scoped.use((req, res, next) => {
  const project = getProject((req.params as { projectId: string }).projectId);
  if (!project) return void res.status(404).json({ error: "No such project in this hub." });
  withProject(project, next);
});
scoped.use("/files", fileRoutes);
scoped.use(api);
app.use("/api/p/:projectId", scoped);
app.use("/api", hubApi);

// The built dashboard, served from the same origin once packaged.
const webDist = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "dist");
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get("*", (_req, res) => res.sendFile(path.join(webDist, "index.html")));
}

app.use((error: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(`[server] ${req.method} ${req.originalUrl}:`, error?.stack ?? error);
  if (!res.headersSent) res.status(error?.status ?? 500).json({ error: error?.message ?? "Unexpected server error." });
});

process.on("unhandledRejection", (reason) => console.error("[unhandled]", reason));

/** A port taken by something else moves to the next one. */
function listen(from: number, attempts = 20): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const tryPort = (candidate: number, left: number) => {
      // It runs a shell-capable agent: a local application, never a LAN service.
      const server = app.listen(candidate, "127.0.0.1");
      server.once("listening", () => resolve({ server, port: candidate }));
      server.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "EADDRINUSE") return reject(error);
        if (left <= 0) return reject(new Error(`Ports ${from} to ${from + attempts - 1} are all in use.`));
        tryPort(candidate + 1, left - 1);
      });
    };
    tryPort(from, attempts - 1);
  });
}

const { server, port: actualPort } = await listen(port, process.env.CLAUDER_HUB_STRICT_PORT ? 1 : 20).catch((error: Error) => {
  console.error(`\n  The server could not start: ${error.message}\n`);
  releaseLock();
  process.exit(1);
});
setHubPort(actualPort);
fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, port: actualPort }), "utf8");

// Terminals are WebSockets: /api/terminals/<terminal id>.
const sockets = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const match = /^\/api\/terminals\/([\w-]+)/.exec(req.url ?? "");
  const terminal = match ? getTerminal(match[1]) : undefined;
  if (!terminal || !allowedOrigin(req.headers.origin, req.headers.host ?? "")) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }
  sockets.handleUpgrade(req, socket, head, (ws) => attachClient(terminal, ws));
});

onTerminalExit((terminal) => cleanRunFiles(terminal.token));
watchRunExits();

console.log(`\n  ✳️  Clauder Hub`);
console.log(`  home    : ${hubHome}`);
// The global context first: the projects' channels check their bots against its own.
bootGlobal();
bootProjects();
let opened = "";
if (requested) {
  try {
    opened = `/#/${addProject(requested).id}`;
  } catch (error) {
    console.error(`  ${(error as Error).message}`);
  }
}

const claude = findClaudeCode();
const underDev = Boolean(process.env.CLAUDER_HUB_DEV);
for (const project of listProjects()) console.log(`  project : ${project.name.padEnd(24)} ${project.root}${project.exists ? "" : "  (folder missing)"}`);
console.log(`  claude  : ${claude ?? "not found. Install it with 'npm i -g @anthropic-ai/claude-code'."}`);
// Whether it runs and is signed in takes a few seconds; said when known, and loudly when it cannot work.
void checkClaudeCode().then((status) => {
  if (status.problem) console.warn(`\n  ⚠ ${status.message} Sessions cannot start until then. Fix: ${status.fix}\n`);
  else if (status.version) console.log(`  claude  : ${status.version}${status.loggedIn ? `, signed in${status.account ? ` as ${status.account}` : ""}` : ""}`);
});
console.log(`  ${underDev ? "api    " : "url    "} : http://localhost:${actualPort}${actualPort !== port ? `  (${port} was in use)` : ""}`);
if (underDev) console.log(`  open    : http://localhost:${webPort}${opened}`);
else if (opened) console.log(`  open    : http://localhost:${actualPort}${opened}`);
console.log(`\n  Every project's sessions, cron jobs and webhooks run as long as this process. Ctrl+C stops the hub and them.\n`);

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    console.log("\n  Stopping the hub...");
    // Sessions first, then each project's schedules, channels and database.
    killAll();
    stopProjects();
    releaseLock();
    // Live-feed streams would hold the server open until the timeout below.
    server.closeAllConnections();
    server.close(() => {
      globalDb.close();
      console.log("  Stopped.\n");
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
