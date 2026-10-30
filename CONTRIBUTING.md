# Contributing

Thanks for helping. Issues and pull requests are welcome at
[goldyndevs/clauder-hub](https://github.com/goldyndevs/clauder-hub).

## Setup

```bash
git clone https://github.com/goldyndevs/clauder-hub.git
cd clauder-hub
npm install
npm run dev -- /path/to/a/project
```

The server (`server/src`, Express + ws) and the page (`web/src`, React +
Tailwind) reload on change. Node.js 22 or newer and a signed-in Claude Code
are needed to start sessions.

## Before a pull request

- `npm run typecheck` and `npm run build` pass.
- Read [CLAUDE.md](CLAUDE.md): it lists the rules the code keeps (nothing
  installed into Claude Code, hooks never decide, answers are typed into the
  pty, every word the hub sends lives in `prompts.ts`, one confirmation dialog).
- Keep changes small and focused, in the style of the code around them.
- For a bug, say how to reproduce it; for a feature, open an issue first if it
  is large.

By contributing you agree that your work is released under the
[MIT License](LICENSE).
