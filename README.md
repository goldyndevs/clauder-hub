# Clauder Hub

**A handy ADE (agentic development environment) for Claude Code: one local dashboard over every Claude Code session on your machine.**

Clauder Hub is a wrapper around Claude Code. It starts real `claude` processes
in real terminals, shows them in your browser, and adds what a single terminal
window cannot give you: every project's sessions in one place, an inbox of
everything Claude is waiting on, answers from your phone, scheduled and
webhook-triggered runs, and stats read straight from the transcripts.

Nothing is reimplemented and nothing is installed into Claude Code. The
terminal you see *is* the `claude` CLI you already use, with your login, your
settings and your plugins.

---

## Why

Claude Code is great in one terminal. It gets messy with five:

- 😵 **Too many windows.** Sessions in several repos, each in its own tab, and
  no way to see at a glance which ones are working, done, or stuck.
- ⏳ **Silent waits.** A session asks for permission or asks a question, and
  sits there for an hour because you were in another window (or away from
  your desk).
- 🔁 **Repeated chores.** Nightly test runs, dependency checks, triage on an
  incoming webhook: you either babysit them or script around the CLI yourself.
- 🧰 **Context bloat.** Every agent, skill, MCP server and plugin you ever
  installed loads into every session, even when the task needs three of them.
- 📊 **No overview.** Where did the tokens go? Which tools, subagents and MCP
  servers did a session actually use?

Clauder Hub keeps all of that in one browser tab, and lets you answer from
Slack or Telegram when you are not at the machine.

---

## Feature tour

### 🖥️ Sessions and terminals

- Every session of a project, read from `~/.claude/projects/...`, including the
  ones you started in a plain terminal.
- **New session** opens a plain `claude` straight in an embedded terminal
  (xterm.js over a pty on the hub). Resume any past session the same way.
- Closing the browser only detaches: the process keeps running in the hub.
  Pop a session out into a window of its own (`#/w/...`) if you like.
- Sessions started outside the hub are visible but have no hooks; resume one
  in the hub to bring it in.

### 🌐 The global page: many projects, one view

- One hub runs per machine and remembers every project you gave it.
- The global page (`#/global`) shows a card per project, **one inbox across all
  of them**, and the global channels.
- Each project keeps its own database, queue, cron jobs, channels, presets and
  categories, and they all keep running while you look at another project.

### 📥 Inbox: everything Claude is waiting on

- Permission requests, `AskUserQuestion` questions, ends of turns, MCP
  suggestions and finished tasks land in the inbox as cards with buttons.
- Answer from the dashboard or from any channel. **The first answer from
  anywhere wins**, and the others are told who answered.
- An answer is delivered by *typing into the pty*, exactly as you would.
  Hooks never approve, deny or delay anything on their own.

### 💬 Channels: Telegram, Slack and webhooks

| Channel | How it connects | Two-way |
| --- | --- | --- |
| Telegram | Bot API, long polling (no public URL needed) | Yes, inline buttons and replies |
| Slack | Socket Mode (no public URL needed) | Yes, blocks, buttons and threads |
| Webhook | JSON, plain text, Discord or Teams (Adaptive Card) | JSON carries a `replyUrl`; chat formats are one-way |

**BotFather-style commands** (on Slack use `!` instead of `/`, since Slack keeps `/` for itself):

| Command | What it does |
| --- | --- |
| `/new <prompt>` | Start a session (alone, it asks for the prompt) |
| `/run <prompt>` | Queue an unattended run |
| `/sessions` | Pick a session; your plain messages then go to it |
| `/summary` | What a session did, read from its transcript (no tokens spent) |
| `/stop` | Stop a running session (asks first) |
| `/queue` | The run queue, with cancel buttons |
| `/cancel`, `/help` | Drop a pending question, or show the menu |

A **global bot** also has `/projects`, `/use <name>` and `/addproject`, and
relays every project's questions labelled with the project name.

**Natural-language fallbacks.** Misspell a command, describe a session instead
of naming it ("the one fixing the login bug"), or describe a folder for
`/addproject` ("my calendar app"), and the hub asks a small Claude model
(Haiku, no tools) for its best guesses. They come back as buttons; **nothing
runs until you press one**. Plain chat on Slack is never guessed at, since
people talk there.

### ⏰ Automation: cron, webhooks and a queue per project

- **Cron jobs** and **webhook triggers** start unattended sessions.
- A webhook is `POST /api/trigger/<job id>` with the job's token in the
  `x-clauder-token` header. `{{payload.field}}` in the job's prompt pulls a
  value from the request body (`{{payload}}` is the whole body, `{{now}}` the time).
- Every run goes through **one queue per project**: runs in a project go one at
  a time, different projects run side by side.
- **Task categories** define what "done" means for a kind of task (a PR, an RCA,
  test evidence...). A session with a category is closed only when Claude
  reports every required deliverable; if something is missing, the hub types
  back what is missing.

### 🧰 Toolsets and presets

- Turn agents, skills, MCP servers and plugins **off** for one session (its
  Toolset tab), or save the choice as a **preset** for jobs and as the default
  for new sessions.
- Applied only through that session's own `--settings` file. Changing a live
  session restarts it on the same conversation.

### 📊 Stats from the transcripts

- Tokens (input, output, cache) by model and by day.
- Tool calls grouped as built-in, MCP (by server), skills and subagents, plus
  each subagent's own tokens and calls.
- All parsed from the JSONL transcripts Claude Code already writes. Nothing
  extra is collected.

### 📁 Files and editor

- A file tree in the sidebar (create, rename, move, delete) and a **Monaco**
  editor with tabs.
- GitLens-style **blame** annotations from `git blame` (read-only, git is only
  asked, never told).

### 📝 Prompts, memory and inventory

- Every word the hub adds to a session or sends to a channel is a prompt you
  can edit and restore (Hub prompts).
- `CLAUDE.md` files, rules, auto memory, agents, skills and commands can be
  edited in place after reviewing a diff.
- Inventory of agents, skills, commands, MCP servers, hooks and plugins by
  scope (user, project, local, plugin).
- **MCP suggestions:** when a session is blocked on a missing integration it
  says so and stops. The `claude mcp add --scope project ...` command runs only
  when you approve it, then the session resumes so the server loads.

### 🤖 No forms: configuration is a conversation

Creating a cron job, a run, a category, a preset or a channel opens a Claude
session with that purpose. Claude asks what it needs, shows the final JSON,
and saves it through the hub API after you say yes.

---

## Use cases

**Approve a permission from your phone.** You step away while Claude refactors
a module. It hits a `Bash` permission prompt; the request arrives in Telegram
with buttons. Tap *Allow*, and the hub types the answer into the terminal.

**Reply late, safely.** You reply to a question an hour later by replying to
its Telegram message. If it was already answered, or the session has moved
on, the hub tells you so (and points at the newer question) instead of
applying your old "yes" to whatever dialog is showing now.

**Nightly jobs with a summary.** A cron job runs `npm test` and triages
failures every night at 2:00. Each run waits its turn in the project's queue,
and its end of turn (or its done report, if the job has a category) lands in
the inbox and your channels. In the morning, `/summary` shows what it did.

**Juggle five projects from one page.** Add each repo once. The global page
shows every project, a single inbox, and one global bot that tags each
message with its project. `/use api-server` then `/new fix the flaky test`
starts work there from chat.

**Add a project by describing it.** Tell the global bot `/addproject my
calendar app`. It looks through your usual code folders and offers matching
folders as buttons; press one and the project is in the hub.

**Trigger Claude from another system.** Point a GitHub, n8n or monitoring
webhook at `POST /api/trigger/<job id>`; the job's prompt picks fields out of
the payload with `{{payload.issue.title}}` and queues a run.

**Lean sessions for focused work.** Make a "frontend" preset that turns off the
database MCP servers and backend agents, and use it for UI jobs and new
sessions.

---

## Quick start

**Requirements**

- Node.js 22 or newer
- [Claude Code](https://docs.claude.com/en/docs/claude-code) installed and
  logged in (`claude` on your PATH)

**Install and run**

```bash
npx clauder-hub "/path/to/your/project"
# or keep it installed:
npm i -g clauder-hub
clauder-hub "/path/to/your/project"     # 'clauder-hub .' for the current folder
```

Open **http://localhost:4329**. The port moves up if it is taken (`--port <n>`
to pick one); the hub prints the one it chose. It remembers its projects, so
later runs can be just `clauder-hub`, and running it again with another path
while the hub is up adds that folder to the running hub. `clauder-hub --help`
lists the options.

---

## How it works

```
             Browser (React + xterm.js)          Telegram / Slack / webhooks
                      |   ^                                |   ^
           REST + WebSocket |                     answers  |   | questions
                      v   |                                v   |
  +-----------------------------------------------------------------------+
  |  Clauder Hub server (Express + ws, 127.0.0.1, one per machine)        |
  |                                                                       |
  |  inbox / channels / queue + cron / stats / files / prompts            |
  +-----------------------------------------------------------------------+
        |  spawns in a pty, types answers         ^  HTTP hooks (answered {} at once)
        v                                         |
  +--------------------------+     writes     +--------------------------+
  |  real `claude` process   | -------------> |  ~/.claude/projects/...  |
  |  --settings (hooks)      |                |  JSONL transcripts       |
  |  --append-system-prompt  |                +--------------------------+
  +--------------------------+                        | read for stats
```

| Need | How |
| --- | --- |
| Show the terminal | `claude` runs in a pty on the hub; the page attaches over a WebSocket |
| Know a session is waiting | HTTP hooks passed per process with `--settings` (SessionStart, UserPromptSubmit, PermissionRequest, PreToolUse for AskUserQuestion, Notification, Stop, SessionEnd). The hub answers each with `{}` immediately, so hooks never decide or delay anything |
| Answer from anywhere | The answer is typed into the pty, as a person would |
| Done reports, MCP suggestions | `--append-system-prompt-file`, read back from the last message by the Stop hook |
| Toolsets | Settings keys merged into the session's own `--settings` file |
| Stats | The JSONL transcripts Claude Code writes anyway |

**Data layout** (`CLAUDER_HUB_HOME` moves it):

```
~/.clauder-hub/
  hub.db            project list and hub prompts
  hub.lock          one hub per machine; a second start hands its folder over
  global/           the global context (global channels, hub tasks)
  projects/<id>/    hub.db per project: sessions, inbox, jobs, channels, presets
  run/              per-terminal --settings files and appended system prompts
```

---

## Safety and privacy

- 🔒 **Local only.** The server listens on `127.0.0.1`, never on your network.
  It runs a shell-capable agent, so keep it that way.
- 🧼 **Nothing installed into Claude Code.** No MCP server, skill, plugin or
  settings file is written. Hooks and the extra prompt are passed per process
  on the command line. The only exceptions are ones you ask for by name:
  running a suggested `claude mcp add --scope project`, or saving an
  instruction file after reviewing its diff.
- 🙅 **Hooks never decide.** Every hook is answered `{}` before the hub does
  anything with it, so the hub cannot approve or block a tool call by itself.
- ✋ **Confirm before acting.** Stopping, deleting, running commands and
  starting unattended runs ask first in the dashboard. Channel guesses are
  buttons that do nothing until pressed.
- 📡 **What leaves the machine:** only what you configure. Channel messages go
  to the Slack, Telegram or webhook you set up, and natural-language guesses
  use your own Claude Code login (a small Haiku call).

---

## FAQ

**Does it replace Claude Code?**
No. It runs the `claude` you already have, in a real terminal. Everything you
can do in Claude Code you still do in that terminal.

**Do I need a server or a public URL for Telegram or Slack?**
No. Telegram uses long polling and Slack uses Socket Mode, both outgoing
connections from your machine.

**What happens to sessions when I close the browser?**
They keep running in the hub. Reopen the page and attach again.

**Can it see sessions I started in a normal terminal?**
Yes, they are listed with their stats. To answer them from the inbox or a
channel, resume them in the hub so they get its hooks.

**Does it cost extra tokens?**
Stats and `/summary` are read from transcripts and cost nothing. Only the
natural-language fallbacks in channels make a small Haiku call.

**Can two hubs run at once?**
One hub runs per machine. Starting another hands its project folder to the
running one.

**Where is my data?**
In `~/.clauder-hub` (or `CLAUDER_HUB_HOME`), plus the transcripts Claude Code
keeps in `~/.claude`.

---

## License

Free to use, not open source: see [LICENSE](LICENSE). © 2026 goldyndevs.
Questions and ideas: goldyndevs@gmail.com
