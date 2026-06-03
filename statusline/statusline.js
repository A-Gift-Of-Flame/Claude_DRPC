#!/usr/bin/env node
// Statusline tier. Set as Claude Code's statusLine command. Claude pipes a JSON
// blob on stdin every render (model, cost, cwd, ...). We stash it for the daemon
// to read exact model/cost numbers, then print a status line.
//
// Chaining: to keep your existing statusline, set env CLAUDE_DRPC_WRAPPED with a
// shell command; we re-pipe the same stdin to it and print its output instead.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { STATE_DIR, STATUS_FILE } = require('../daemon/paths');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let d = {};
  try { d = JSON.parse(raw); } catch {}

  // stash for daemon
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATUS_FILE, JSON.stringify({ ...d, _ts: Date.now() }));
  } catch {}

  // chain to a wrapped statusline if configured
  if (process.env.CLAUDE_DRPC_WRAPPED) {
    try {
      const out = execSync(process.env.CLAUDE_DRPC_WRAPPED, { input: raw, encoding: 'utf8' });
      process.stdout.write(out);
      return;
    } catch {}
  }

  // otherwise print our own line
  const model = (d.model && d.model.display_name) || 'Claude';
  const wsdir = (d.workspace && d.workspace.current_dir) || d.cwd || '';
  const project = wsdir ? path.basename(wsdir) : '';
  const cost = d.cost && typeof d.cost.total_cost_usd === 'number'
    ? '$' + d.cost.total_cost_usd.toFixed(2) : '';
  process.stdout.write([project, model, cost].filter(Boolean).join('  ·  '));
});
