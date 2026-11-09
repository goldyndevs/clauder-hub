<h1 align="center">
  <a href="https://github.com/goldyndevs/clauder-hub"><img src="logo.svg" width="64" alt="Clauder Hub logo"></a>
  <br>
  Clauder Hub
</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/clauder-hub"><img src="https://img.shields.io/npm/v/clauder-hub?color=d97757" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/clauder-hub"><img src="https://img.shields.io/npm/dm/clauder-hub" alt="npm downloads"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D22-339933" alt="Node 22 or newer"></a>
  <a href="https://github.com/goldyndevs/clauder-hub/stargazers"><img src="https://img.shields.io/github/stars/goldyndevs/clauder-hub?style=flat" alt="GitHub stars"></a>
</p>

<p align="center">
  <b>Every Claude Code session on your machine, in one browser tab.</b><br>
  A handy ADE and wrapper around Claude Code.
</p>

<p align="center">
  <img src="docs/assets/hero.jpg" width="960" alt="Clauder Hub: a Claude Code session in its terminal, waiting on a permission, with the project's sessions in the sidebar">
</p>

<p align="center">
  <code>npx clauder-hub .</code>
</p>

---

## Features

Clauder Hub runs the real `claude` you already use, in real terminals, and adds what one terminal window cannot: every project at once, an inbox of everything Claude is waiting on, answers from your phone, scheduled runs and stats. Nothing is reimplemented and nothing is installed into Claude Code.

<table>
  <tr>
    <td width="40%">
      <h3>Real terminals, live activity</h3>
      <b>New session</b> opens a plain <code>claude</code> in an embedded xterm. Close the tab and it keeps running; every tool call, token and subagent is read from the transcripts as it goes.
    </td>
    <td width="60%">
      <picture>
        <source srcset="docs/assets/terminal.webp" type="image/webp">
        <img src="docs/assets/terminal.jpg" width="100%" alt="Starting a session and typing a prompt; Claude reads, edits and asks to run npm test">
      </picture>
    </td>
  </tr>
  <tr>
    <td>
      <h3>One inbox for every project</h3>
      Permissions, questions and finished turns from all your projects land in one place, with buttons. The answer is typed into the terminal, and the first answer from anywhere wins.
    </td>
    <td>
      <picture>
        <source srcset="docs/assets/inbox.webp" type="image/webp">
        <img src="docs/assets/inbox.jpg" width="100%" alt="The global inbox: allowing npm test and picking Redis, then each session comes back with its next question">
      </picture>
    </td>
  </tr>
  <tr>
    <td>
      <h3>Answer from your phone</h3>
      Telegram and Slack bots relay every question with inline buttons, and BotFather-style commands (<code>/new</code>, <code>/jobs</code>, <code>/sessions</code>, <code>/summary</code>, <code>/stop</code>) drive sessions from chat. No public URL needed.
    </td>
    <td>
      <picture>
        <source srcset="docs/assets/telegram.webp" type="image/webp">
        <img src="docs/assets/telegram.jpg" width="100%" alt="A Telegram chat with the hub's bot: a permission card with Allow and Deny buttons, then the /sessions picker">
      </picture>
    </td>
  </tr>
  <tr>
    <td>
      <h3>Cron, webhooks and a queue</h3>
      Nightly test triage, weekly dependency audits, a run per new GitHub issue. Each project has one queue that runs one or several runs side by side, jobs take <code>{{parameters}}</code> asked by Run now or sent by the webhook, and a task category defines what "done" means before a run may close.
    </td>
    <td>
      <img src="docs/assets/automation.jpg" width="100%" alt="The Automation page: cron and webhook jobs and the queue of finished runs">
    </td>
  </tr>
  <tr>
    <td>
      <h3>Toolsets and presets</h3>
      Turn agents, skills, MCP servers and plugins off for one session, or save the choice as a preset for jobs and new sessions. Applied through that session's own <code>--settings</code>, nothing else.
    </td>
    <td>
      <img src="docs/assets/toolsets.jpg" width="100%" alt="Toolset presets: switches for plugins and agents in a Frontend preset">
    </td>
  </tr>
  <tr>
    <td>
      <h3>Stats from the transcripts</h3>
      Tokens by day and by model, built-in tools, MCP servers, skills and subagents, per project and per session. Parsed from the JSONL Claude Code already writes, so it costs nothing.
    </td>
    <td>
      <img src="docs/assets/stats.jpg" width="100%" alt="The project overview: token totals, output tokens per day, tokens by model, tool and MCP usage">
    </td>
  </tr>
  <tr>
    <td>
      <h3>Files and editor</h3>
      A file tree and a Monaco editor with tabs sit beside your sessions, with GitLens-style blame from <code>git blame</code>. Tick <b>Changed</b> to see only what git sees changed, and open a file as a side by side diff against HEAD, editable on the right, as in VS Code.
    </td>
    <td>
      <img src="docs/assets/files.jpg" width="100%" alt="The Files tab and the editor showing src/lib/cart.ts with its last change">
    </td>
  </tr>
</table>

**Also in the box:**

- **The global page.** A card per project with what is running, waiting and queued, plus one global bot that tags each message with its project (`/projects`, `/use`, `/addproject`).
- **Many sessions at once.** A live panel of every project's sessions, terminals kept alive while you switch, and keys for the moves you repeat: Ctrl+K to jump anywhere, Alt+1..9 for the open sessions, Alt+W for the next one waiting on you, Ctrl+F to search a terminal, Ctrl+Enter to send now. Drop a file on a terminal to paste its path; select text to copy it.
- **Several Claude accounts.** Add accounts on the global page, each with its own sign-in, and pick one for the hub, per project or per session. Skills, agents, plugins and settings stay shared.
- **Survives a restart.** Sessions running when the hub stops (or crashes) are resumed when it starts again; queued runs go back on the queue.
- **Forms, or Claude.** Jobs, runs, categories, presets and channels have forms; **Set up with Claude** hands the form to a Claude session instead, which carries on from what you filled in.
- **Variables.** The env and headers Claude Code gets from `.mcp.json`, `~/.claude.json` and the settings files, masked, with token expiry (JWTs, GitHub) and rotation written straight into the file after a confirm.
- **Where things stand.** The project's git branch and changes at the foot of the sidebar, recent projects under its name, and on the global page each Claude account with its plan, its session and weekly usage (read from Claude Code's own `/usage`, no tokens spent) and today's tokens.
- **Settings.** A global Settings page: the live panel, asking before a session is stopped, resuming after a restart.
- **Natural-language fallbacks.** Misspell a command or describe a session ("the one fixing the login bug") and a small Haiku call offers its guesses as buttons. Nothing runs until you press one.
- **Prompts, memory and inventory.** Edit every word the hub adds to a session, edit `CLAUDE.md`, rules, agents and skills after a diff, and see every agent, skill, command, MCP server, hook and plugin by scope.
- **MCP suggestions.** A session blocked on a missing integration says so; `claude mcp add --scope project` runs only when you approve it.
- **Desktop notifications** on Windows, macOS and Linux, and webhooks to Discord, Teams or your own endpoint.
- **Local only.** The server listens on `127.0.0.1`. Hooks are answered `{}` at once, so the hub can never approve or block a tool call by itself.

---

## Install

**Requirements:** Node.js 22 or newer, and [Claude Code](https://docs.claude.com/en/docs/claude-code) installed and signed in (`claude` on your PATH).

```bash
npx clauder-hub .              # the current folder
npx clauder-hub ~/code/my-app  # or any project folder
```

Or keep it installed:

```bash
npm i -g clauder-hub
clauder-hub .
```

Open **http://localhost:4329**. If the port is taken the next free one is used (`--port <n>` picks one). The hub remembers its projects, so later runs can be just `clauder-hub`; running it again with another folder adds that folder to the hub already running. `clauder-hub --help` lists the options.

Data lives in `~/.clauder-hub` (`CLAUDER_HUB_HOME` moves it): the project list, one database per project, and per-terminal settings files.

---

## Developing

```bash
git clone https://github.com/goldyndevs/clauder-hub.git
cd clauder-hub
npm install
npm run dev -- /path/to/a/project   # server and web with reload
```

`npm run typecheck` and `npm run build` before a pull request. See [CONTRIBUTING.md](CONTRIBUTING.md) and [CLAUDE.md](CLAUDE.md) for how the code is laid out and the rules it keeps.

---

## FAQ

**Does it replace Claude Code?**
No. It runs the `claude` you already have, with your login, settings and plugins, in a real terminal.

**Does it write anything into my Claude Code setup?**
No. Hooks and the extra system prompt are passed per process with `--settings` and `--append-system-prompt-file`. The only exceptions are ones you ask for by name: a suggested `claude mcp add --scope project`, saving an instruction file after its diff, or rotating a value on the Variables page. An added Claude account gets a folder of its own under `~/.clauder-hub/profiles`.

**Do I need a public URL for Telegram or Slack?**
No. Telegram uses long polling and Slack uses Socket Mode, both outgoing connections.

**What happens when I close the browser?**
Sessions keep running in the hub. Reopen the page and attach again.

**And when I stop the hub?**
Its sessions stop with it, and come back by themselves the next time it starts (a switch on the global page turns that off). Their conversations are in Claude Code's transcripts either way.

**Can it see sessions I started in a normal terminal?**
Yes, with their stats. Resume one in the hub to answer it from the inbox or a channel.

**Does it cost extra tokens?**
Stats and `/summary` are read from transcripts. Only the natural-language fallbacks in channels make a small Haiku call.

---

## License

[MIT](LICENSE) © goldyndevs
