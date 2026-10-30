# Clauder Hub

A local dashboard for the Claude Code sessions of your projects. It runs real
`claude` processes in real terminals, shows what every session did (tokens,
tool calls, subagents, skills, MCP calls), and automates sessions with cron
jobs and webhooks. Questions and permission requests go out to Slack,
Telegram or any webhook, and a reply there is typed into the session.

Nothing is installed into Claude Code to do this: no MCP server, no skill, no
settings file is written. Each session the hub starts gets its hooks and an
appended system prompt through command-line flags, for that process only.

## Start

```bash
cd your-project
npx clauder-hub .
```

Then open the URL it prints (default http://localhost:4329). Needs Node 22+
and Claude Code installed and signed in.

One hub runs per machine and keeps every project it was given. The global page
(`#/`) shows them all, with one inbox and the channels that serve every
project; it opens another folder (so does `/addproject` on a global bot), and
the chip beside a project's name switches between them. Each project's sessions, cron jobs,
webhooks and channels keep running while another one is shown. Running
`npx clauder-hub <path>` while the hub is up adds that folder to it.

## What it does

- **Sessions.** Every session of the project, from `~/.claude/projects/<project>/`,
  including ones started in a plain terminal. Start a new one, or resume any
  of them, in a terminal embedded in the page (xterm.js over a pty). Closing
  the page only detaches; the process keeps running in the hub.
- **Activity.** Tokens (input, output, cache) by model and by day, tool calls
  grouped as built-in, MCP (by server), skills and subagents, and each
  subagent's own tokens and calls. All read from the transcripts.
- **Inventory.** Agents, skills, commands, MCP servers, hooks and plugins, by
  scope (user, project, local, plugin).
- **Automation.** Cron jobs and webhook triggers start unattended sessions,
  one at a time, through a single queue. A webhook is
  `POST /api/trigger/<job id>` with the job's token in `x-clauder-token`;
  `{{payload.field}}` in the prompt takes a value from the request body.
- **Task categories.** Define what "done" means per kind of task (a PR, an
  RCA, test evidence, ...). A session with a category is closed only when
  Claude reports every required deliverable.
- **Channels.** Slack (Socket Mode), Telegram (long polling) and generic
  webhooks (JSON, Teams, Discord). Permission requests, questions, ends of
  turns, MCP suggestions and finished tasks go to all of them; the first
  answer from anywhere wins.
- **MCP suggestions.** When a session is blocked on a missing integration, it
  says so and stops. The suggestion is kept, and the install command
  (`claude mcp add --scope project ...`) runs only when you say so; the
  session is then resumed so the server loads.
- **Toolsets.** Turn agents, skills, MCP servers and plugins off for one
  session (its Toolset tab), or save the choice as a preset for jobs and as
  the default for new sessions. Applied through the session's own
  `--settings`; changing a live session restarts it on the same conversation.
- **Prompts & memory.** Every prompt the hub adds is editable and restorable.
  `CLAUDE.md` files, rules, auto memory, agents, skills and commands can be
  edited in place after reviewing a diff.

## How it reaches the sessions

| Need | How |
| --- | --- |
| Show the terminal | `claude` runs in a pty on the hub; the page attaches over a WebSocket |
| Know a session waits on someone | HTTP hooks passed with `--settings` (SessionStart, UserPromptSubmit, PermissionRequest, PreToolUse for AskUserQuestion, Notification, Stop, SessionEnd). The hub answers each with `{}` at once, so they never decide or delay anything |
| Answer from a channel | The answer is typed into the pty, as a person would |
| Done protocol, MCP suggestions | `--append-system-prompt-file`, read back from the last message by the Stop hook |
| Stats | The JSONL transcripts Claude Code writes anyway, polled |

Sessions started outside the hub are visible but have no hooks, so channels
cannot reach them. Resume one in the hub to bring it in.

## Development

```bash
npm install
npm run dev -- "C:\path\to\a\project"
```

Runtime state lives in `~/.clauder-hub/` (`CLAUDER_HUB_HOME` moves it): the
project list, and each project's database under `projects/<id>/`. A project
used with an older hub has its `<project>/.clauder-hub/data` imported once.
