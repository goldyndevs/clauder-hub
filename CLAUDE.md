# Clauder Hub

A local dashboard over the Claude Code sessions of every project on the
machine: real `claude` processes in ptys shown with xterm.js, stats read from
the transcripts, cron/webhook automation through a queue per project, and
channels (Slack, Telegram, webhooks) that relay what sessions ask.

## The rules that matter

- **Many projects, each kept apart.** One hub runs per machine (`hub.lock` in
  `~/.clauder-hub`; a second start hands its folder to the running one). Every
  project has its own database (`~/.clauder-hub/projects/<id>/hub.db`), queue,
  cron jobs, channels, Claude settings, categories and presets, and all of
  them run whichever project the page shows. Only the project list and the
  hub prompts are global (`globalDb`). Work runs inside a project context
  (`server/src/context.ts`, AsyncLocalStorage): `/api/p/<id>/...` enters it,
  a hook finds it from its terminal's token, cron ticks, channel replies, pty
  events and timers are wrapped with `bindProject`. `db`, `projectRoot()` and
  `transcriptsDir()` read it, so a callback that outlives its request must be
  bound, and module state keyed by an id that is only unique per project must
  carry the project id. `projects.ts` adds, boots and stops projects; a
  project's old `<project>/.clauder-hub/data/hub.db` is imported once. The
  page routes are `#/global/...` (also `#/`; there is no separate home: the
  global page opens and adds folders) and `#/<project id>/...`; `web/src/lib/project.ts` prefixes every project call,
  and `lib/projectStores.ts` swaps what the page keeps per project.
- **The global context (`#/global`).** The hub's own context beside the
  projects, id `global`, a folder `~/.clauder-hub/global` and a database
  there; never listed as a project, served at `/api/p/global` so its hub
  tasks and terminals reuse the project code. Its channels are the global
  channels: `channels/index.ts` `notifyChannels` delivers to the project's
  own, then to the global ones (unless muted there) with the project's name,
  storing `project_id` on `channel_refs`/`channel_threads`; a reply there is
  routed back into that project (`handleGlobalReply`), and `/projects`,
  `/use` pick the project the other commands act on (card buttons carry
  `@<project id>`). A bot listens in one place only (`refuseSharedBot`).
  The page shows every project's card, one inbox (`/api/global/*`) and the
  global channels.
- **Nothing is installed into Claude Code.** No MCP server, skill, plugin or
  settings file is written. A session gets the hub's hooks with `--settings`
  and its prompt with `--append-system-prompt-file`, per process, from
  `server/src/sessions.ts`. The only exceptions are things the user asks for
  by name: running a suggested `claude mcp add` (always `--scope project`)
  and saving an instruction file from Prompts & memory after a diff.
- **The terminal is not reimplemented.** The page shows the pty as it is. An
  answer from a channel or the dashboard is delivered by typing into the pty
  (`terminals.ts`: `pressKeys`, `typeMessage`), never by another API.
- **Hooks never decide and never wait.** `/api/hooks/:token` answers `{}`
  before doing anything (`routes.ts`), so a hook can neither approve nor delay
  a tool call. Keep it that way.
- **Stats are read, not collected.** `transcripts.ts` parses the JSONL Claude
  Code writes. The format is private: read every field defensively, and
  dedupe usage by `message.id` (one line per content block repeats it) and a
  fork's inherited lines against its parent.
- **One queue per project.** Every triggered run goes through `jobs.ts`
  `enqueue` and runs alone in its project; projects run side by side. A run
  ends when its session reports done (`hooks.ts` `onStop`) or its terminal
  exits.
- **Every word the hub sends is in `prompts.ts`** and read through
  `promptText`/`renderPrompt`, so the Prompts page can override it.
- **One confirmation.** Anything that deletes, stops, writes a file, runs a
  command or starts an unattended run asks through `useConfirm()`
  (`web/src/components/Confirm.tsx`), passing the action as `run` so the
  dialog stays busy until it is through. Never the browser's `confirm()`.
  Answering an interaction is the exception: it is a reply, like typing.
  So is the sidebar's Files tab (`FileTree.tsx`, `server/src/files.ts`): the
  user chose no dialog there for save, create, rename/move or delete; delete
  stays in the row's context menu, never an always-visible button.
- **Menu groups.** Operation (what is happening), Project (what sessions are
  made of, all scopes), Settings (how the hub behaves), under the sidebar's
  Workspace tab; the Sessions tab lists the sessions. `NAV_GROUPS` in
  `Sidebar.tsx`; pages are `PAGES` in `store.ts`. `#/w/...` is the same view
  in a window of its own, without the sidebar. New session starts a plain
  `claude` straight into its terminal, no form.
- **Toolsets go through --settings only.** `toolset.ts` turns "what is off"
  into settings keys merged into the session's own `--settings` file:
  plugins `enabledPlugins: false`, user/project skills `skillOverrides: "off"`
  (both leave the context), agents `Agent(name)` deny, plugin skills
  `Skill(name)` deny and MCP servers `mcp__server` deny (block use only). It is
  read at start-up, so changing a live session goes through `restartSession`.
  Hooks and commands are not offered: Claude Code can only turn all of them off.
- **Markdown is shown through `MarkdownBox`** (`web/src/components/ui/MarkdownBox.tsx`):
  View mode (rendered) by default, Edit mode (raw) behind an icon switch in its
  top-right corner. Without `onChange` the raw text is read-only.
- **One presented shape per interaction.** `server/src/presentation.ts`
  turns an interaction into a headline, question, choices, quick replies and
  folded details. The inbox card and every channel draw from it (Slack blocks
  and Telegram inline buttons send a choice ref that `resolveChoice` turns back
  into the answer). The channel prompts in `prompts.ts` stay as the plain-text
  notification and fallback.
- **Channel commands, BotFather style.** `channels/commands.ts`: `/new`,
  `/run`, `/sessions`, `/summary`, `/stop`, `/queue`, `/cancel`, `/help`
  (`!` on Slack, which takes `/` for its own). Answers are `ChannelCard`s
  (title, lines, quote, buttons that run another command, `c|<command>`);
  a button turns its card into the answer, and a missing argument is asked
  for. Only a message that leads to no session is a command: in a session's
  thread, text goes to the session. `/summary` reads the transcript, no tokens.
  When what was typed does not fit (a misspelled command, a session or
  project described instead of named, text with nowhere to go, a folder
  described for `/addproject`), `smallModel.ts` asks Claude (Haiku, no tools,
  in the hub's own folder) and the guesses come back as buttons; nothing runs
  until one is pressed. Plain text on Slack is never guessed at: people talk
  there. The questions are `typed.pickMatches`, `typed.interpretCommand` and
  `typed.findFolders` in `prompts.ts`.
- **No forms: configuration is a Claude session.** Creating or editing a
  job, a run, a category, a preset or a channel opens a session with a
  `purpose` (`server/src/purposes.ts`); the general `hub` purpose covers all of
  them at once. Its note (purpose, every parameter
  with an example, samples, the API) is shown highlighted at the top of the
  session and appended to its system prompt; Claude asks, shows the final JSON,
  saves through the hub API with curl after a yes, and the session stays open
  for more edits. Adding a field to one of these objects means adding it to
  its param list there. Toggling a preset's switches is the one direct editor kept.
- **Server pushes topics, not state.** `events.ts` broadcasts "this changed";
  the page refetches through the same API (`useLive` in `web/src/lib/store.ts`).

## Layout

- `server/src/` Express + ws. `index.ts` boots; `routes.ts` is the API: `api`
  per project, `hubApi` for the hub (projects, folders, the live feed, hooks).
- `server/src/channels/` one adapter per platform behind `types.ts`.
- `web/src/` React + Tailwind + Radix, styled like claude-review-hub
  (`components/ui` is shared with it).

## Commands

- `npm run dev [-- <project path>]` runs both halves with reload; a path adds
  that project to the hub.
- `npm run typecheck`, `npm run build`.
