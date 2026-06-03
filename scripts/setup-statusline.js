#!/usr/bin/env node
// Wire the statusline tier into ~/.claude/settings.json.
// - backs up settings.json
// - if you already have a statusLine command, it is preserved via CLAUDE_DRPC_WRAPPED
// Usage: node scripts/setup-statusline.js
const fs = require('fs');
const os = require('os');
const path = require('path');

const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
const statusline = path.resolve(__dirname, '..', 'statusline', 'statusline.js');

let settings = {};
if (fs.existsSync(settingsPath)) {
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); }
  catch (e) { console.error('settings.json is not valid JSON:', e.message); process.exit(1); }
  fs.copyFileSync(settingsPath, settingsPath + '.drpc-backup');
  console.log('backed up ->', settingsPath + '.drpc-backup');
}

const existing = settings.statusLine;
const ours = `node "${statusline}"`;

if (existing && existing.command && !existing.command.includes('statusline.js')) {
  // preserve user's current statusline by wrapping it
  const wrapped = existing.command.replace(/"/g, '\\"');
  settings.statusLine = {
    type: 'command',
    command: `CLAUDE_DRPC_WRAPPED="${wrapped}" ${ours}`
  };
  console.log('preserved existing statusline via CLAUDE_DRPC_WRAPPED');
} else {
  settings.statusLine = { type: 'command', command: ours };
}

fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
console.log('statusLine configured ->', settings.statusLine.command);
console.log('restart Claude Code sessions to apply.');
