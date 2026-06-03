# claude-discord-rpc

Show what you're working on in Claude Code as a live **Discord Rich Presence** —
project, git branch, current activity, model, token count, cost, and session
time. Works whether you run Claude Code in a terminal or the desktop app.

> **Unofficial / third-party project.** Not affiliated with, endorsed by, or
> sponsored by Anthropic. "Claude" and "Claude Code" are trademarks of
> Anthropic PBC, used here only to describe compatibility (nominative fair
> use). Ships its own icon — not the Anthropic logo.

## What it shows

While you work, your Discord profile displays:

- 📂 **Project** you're in (and **git branch**)
- ⚡ **Activity** — e.g. *Using Edit*, *Thinking…*
- 🧠 **Model** (e.g. Opus 4.8) · **tokens** · **cost** · **session time**

It updates as you go and clears itself when you stop.

## Requirements

- **Claude Code** and **Node.js** (already have both if you're here).
- The **Discord desktop app** running (Rich Presence uses its local socket;
  the Discord *web* app can't show presence).

## Install

No Discord developer setup needed — the plugin ships with a working app and
icon built in. In Claude Code, add this marketplace and install:

```
/plugin marketplace add A-Gift-Of-Flame/Claude_DRPC
/plugin install claude-discord-rpc@claude-drpc
```

Make sure the **Discord desktop app is running**, then start a new session —
your presence appears within a few seconds.

That's it. The next section is optional.

### Better cost numbers (optional but recommended)

By default, cost is *estimated* from a built-in pricing table (which drifts).
Enable the statusline tier to show Claude's **own exact** model + cost — just
run the bundled command in Claude Code:

```
/drpc-statusline
```

It backs up `~/.claude/settings.json` and points `statusLine` at the plugin;
any existing statusline is preserved and still runs (wrapped via
`CLAUDE_DRPC_WRAPPED`). Restart your sessions to apply.

> Prefer doing it by hand? Run `node scripts/setup-statusline.js` from the
> installed plugin directory — same effect.

### Use your own Discord app (advanced)

The built-in app is fine for most people. Make your own only if you want the
presence to show **your own name/icon** instead of the bundled one (e.g. you're
forking this):

1. Create an app at <https://discord.com/developers/applications>, copy its
   **Application ID**.
2. Under **Rich Presence → Art Assets**, upload an icon named `claude` (the
   bundled [`assets/icon.png`](assets/icon.png) works).
3. Point the plugin at your app by setting `CLAUDE_DRPC_CLIENT_ID` in your
   environment. (If you've forked the repo, you can instead edit `clientId` in
   `config.json` and install from your fork.)

## Configuration (`config.json`)

| key | meaning |
|-----|---------|
| `clientId` | Discord Application ID |
| `largeImage` | art-asset key for the big icon (default `claude`) |
| `largeText` | hover text for the big icon |
| `smallImage` | optional small overlay icon key |
| `idleExitMinutes` | stop the presence after this many idle minutes (default 10) |
| `debug` | write a log to `~/.claude/drpc/daemon.log` |

All runtime state lives under `~/.claude/drpc/` — never inside the repo.

## Behavior & limits

- One presence at a time: it follows your **most recently active** session.
- **Exiting cleanly** (`/exit`) stops the presence right away. Closing the
  terminal / killing the process is detected within ~5s on Linux; on macOS and
  Windows it clears after the idle timeout instead.
- Discord socket discovery covers Linux/macOS (plain, snap, flatpak) and
  Windows named pipes.

## Tested platforms

Actively tested on **Debian 13 (Linux x86_64)** only. The macOS and Windows
code paths exist but are **untested** — reports and fixes welcome.

| platform | status |
|----------|--------|
| Linux x86_64 (Debian 13) | ✅ tested |
| macOS | ⚠️ untested (should work) |
| Windows | ⚠️ untested (should work) |

## Troubleshooting

- **No presence?** Confirm the Discord *desktop* app is running, your
  Application ID is set, and you started a **new** Claude Code session after
  enabling.
- **Icon is blank?** The asset key in `largeImage` must exactly match the Art
  Asset name you uploaded (`claude` by default).
- **Dig deeper:** set `"debug": true` in `config.json` and read
  `~/.claude/drpc/daemon.log`, or run the daemon in the foreground:

  ```bash
  CLAUDE_DRPC_CLIENT_ID=YOUR_ID node daemon/daemon.js
  ```

---

## How it works (and why the daemon costs zero tokens)

Claude Code has no persistent "extension host" process you can write against.
Its extension points are one-shot scripts (hooks) or context-injecting MCP
servers — and MCP servers that expose tools cost input tokens every turn,
because their schemas load into the prompt.

This plugin sidesteps that entirely:

```
SessionStart hook ──► launcher.js (one-shot) ──► spawns daemon.js (detached)
                                                       │
                                  watches ~/.claude/projects/*/*.jsonl
                          (+ optional statusline state for exact model/cost)
                                                       │
                                          holds Discord IPC socket
```

- The **hook** fires once per session, launches the daemon, and exits. Free.
- The **daemon** runs *outside* Claude entirely. The model never sees it →
  **zero token cost** for the presence itself.

The only thing the model ever sees is the optional `/drpc-statusline` command's
one-line description (~55 tokens/session, loaded like any slash command). The
actual presence — the daemon, the hooks, the IPC — adds nothing to your
context. Don't want even that? Skip the command and run
`scripts/setup-statusline.js` by hand instead.

It reads two data sources:

| tier | setup | gives |
|------|-------|-------|
| **JSONL** (default) | none | project, branch, activity, token count, *approx* cost, model id |
| **statusline** (recommended) | `setup-statusline.js` | **exact** model name + cost, from Claude's own numbers |

Token counts always come from JSONL `usage` records (cache reads excluded from
the displayed count). Cost uses the statusline number when available, else the
`config.json → pricing` table.
