#!/usr/bin/env node
// Run by the SessionEnd hook (fires on clean exit: /exit, ctrl-D, clear).
// Writes a marker so the daemon stops reporting this session immediately,
// instead of waiting out idleExitMinutes. Reads hook JSON from stdin.
const fs = require('fs');
const { STATE_DIR, ENDED_FILE } = require('./paths');

let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  let sessionId = null;
  try { sessionId = JSON.parse(raw).session_id || null; } catch {}
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(ENDED_FILE, JSON.stringify({ sessionId, ts: Date.now() }));
  } catch {}
  process.exit(0);
});
// stdin may be empty/closed; guard so the hook never hangs.
setTimeout(() => process.exit(0), 1000);
