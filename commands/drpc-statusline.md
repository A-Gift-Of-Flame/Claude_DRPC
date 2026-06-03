---
description: Enable the DRPC statusline tier — show Claude's exact model + cost in your Discord presence
allowed-tools: Bash(node:*)
---

Run the bundled setup script to wire the Claude DRPC statusline tier into
`~/.claude/settings.json` (it backs the file up first, and preserves any
existing statusline via `CLAUDE_DRPC_WRAPPED`):

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/setup-statusline.js"`

Report the result to the user in one or two lines:
- Confirm the statusline was configured (and that a backup was written).
- If the output mentions `CLAUDE_DRPC_WRAPPED`, note that their previous
  statusline was preserved and still runs.
- Remind them to **restart their Claude Code sessions** to apply.

If the script errored (e.g. invalid `settings.json`), surface the error
verbatim instead of claiming success.
