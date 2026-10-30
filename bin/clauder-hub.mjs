#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, "..", "server", "dist", "index.js");

const args = process.argv.slice(2);

if (args.includes("-h") || args.includes("--help")) {
  console.log(`
  clauder-hub [project path] [--port <n>]

  Opens the dashboard for the Claude Code sessions of your projects. One hub
  runs per machine and keeps every project it was given: their sessions, cron
  jobs and webhooks run as long as it does. A path adds that project and opens
  it ('clauder-hub .' for the current folder); when a hub is already running,
  the path is handed to it.

  --port <n>     Preferred port (default 4329). If it is taken, the next free
                 one is used.
  version        Print the version.

  Examples:
    npx clauder-hub "C:\\Source code\\your-repo"
    cd your-repo && npx clauder-hub .
    npx clauder-hub
`);
  process.exit(0);
}

if (args[0] === "version") {
  const pkg = JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8"));
  console.log(pkg.version);
  process.exit(0);
}

function flag(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

const positional = args.find((arg, index) => !arg.startsWith("-") && args[index - 1] !== "--port");
const target = positional ? path.resolve(positional) : "";

if (target && (!fs.existsSync(target) || !fs.statSync(target).isDirectory())) {
  console.error(`\n  ${target} is not a folder.\n`);
  process.exit(1);
}

if (!fs.existsSync(serverEntry)) {
  console.error(`\n  The hub has not been built yet.\n  Run 'npm run build' in ${path.join(here, "..")}\n`);
  process.exit(1);
}

const port = flag("--port");
if (port) process.env.PORT = port;
if (target) process.env.CLAUDER_HUB_PROJECT = target;

await import(pathToFileURL(serverEntry).href);
