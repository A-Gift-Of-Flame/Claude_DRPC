# claude-discord-rpc

Discord Rich Presence for Claude Code (terminal **and** desktop). Shows your
current project, git branch, and what Claude is doing right now.

Shows project, git branch, current activity, **model, token count, cost, and
session time** in Discord.

## How it works (and why it's free)

Unlike a VS Code extension, Claude Code has no persistent "extension host"
process you can author. Its plugin points are either one-shot scripts (hooks)
or context-injecting MCP servers. MCP servers that expose tools cost input
tokens every turn because their schemas load into the prompt.

This plugin avoids all of that:

```
SessionStart hook ──► launcher.js (one-shot) ──► spawns daemon.js (detached)
                                                       │
                                  watches ~/.claude/projects/*/*.jsonl
                          (+ optional statusline state for exact model/cost)
                                                       │
                                          holds Discord IPC socket
```

- **Hook** fires once per session, just launches the daemon, exits. Free.
- **Daemon** runs *outside* Claude entirely. The model never sees it →
  **zero token cost**. Same passive-watcher model as a VS Code extension,
  the daemon just has to be declared instead of riding a built-in host.

## Two data tiers

| tier | setup | gives |
|------|-------|-------|
| **JSONL** (default) | none | project, branch, activity, token count, *approx* cost (pricing table), model id |
| **statusline** (preferred) | run setup script | **exact** model display name + cost, straight from Claude's own numbers |

Token counts always come from JSONL `usage` records. Cost prefers the
statusline number when present; otherwise it's estimated from
`config.json → pricing` (verify those rates — they drift).

### Enable the statusline tier

```bash
node scripts/setup-statusline.js
```

Backs up `~/.claude/settings.json`, points `statusLine` at
`statusline/statusline.js`. If you already have a statusline, it's preserved
and re-invoked via `CLAUDE_DRPC_WRAPPED`. Restart sessions to apply.

## Setup

1. **Create a Discord application** at <https://discord.com/developers/applications>.
   Copy the **Application ID** (Client ID).
2. Under **Rich Presence → Art Assets**, upload an image and name its key
   `claude` (or change `largeImage` in `config.json`).
3. Put the Client ID in `config.json`:
   ```json
   { "clientId": "123456789012345678", "largeImage": "claude" }
   ```
   …or export `CLAUDE_DRPC_CLIENT_ID` instead.
4. Make sure the Discord **desktop app** is running (RPC needs the local
   client; the web app does not expose the IPC socket).
5. Install the plugin so Claude Code loads `hooks/hooks.json`.

## Config (`config.json`)

| key | meaning |
|-----|---------|
| `clientId` | Discord Application ID |
| `largeImage` | art-asset key for the big icon |
| `largeText` | hover text for big icon |
| `smallImage` | optional small overlay icon key |
| `idleExitMinutes` | daemon self-exits after this much inactivity (default 10) |
| `debug` | write a log to `$TMPDIR/claude-drpc.log` |

## Notes / limits

- One daemon serves all sessions; it always shows the **most recently active**
  transcript. Pidfile (`$TMPDIR/claude-drpc.lock`) prevents duplicates.
- No clean "session end" signal exists, so the daemon self-exits once
  transcripts go stale (`idleExitMinutes`) and clears presence on the way out.
- Linux/macOS socket discovery covers plain, snap, and flatpak Discord
  installs. Windows named pipes are not handled yet.

## Test manually

```bash
CLAUDE_DRPC_CLIENT_ID=YOUR_ID node daemon/daemon.js   # foreground, with debug=true to log
```
