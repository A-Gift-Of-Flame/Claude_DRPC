#!/usr/bin/env node
// One-shot launcher. Run by SessionStart hook. Spawns the daemon detached,
// then exits immediately so the hook returns. Guards against duplicates via pidfile.
//
// Also records a liveness marker (live.json) pinning this session to the live
// `claude` process PID, so the daemon can stop reporting the instant that process
// dies on a dirty terminal kill (SIGHUP) — which never fires SessionEnd. Linux
// only (walks /proc); on other platforms we skip it and fall back to idle-timeout.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { LOCK, ENDED_FILE, LIVE_FILE, STATE_DIR } = require('./paths');

// Matches the `claude` command without matching the `.claude` config-dir path
// that litters hook-shell cmdlines (e.g. /home/u/.claude/shell-snapshots/...),
// which would otherwise pin us to a transient shell instead of the real TUI.
const CLAUDE_RE = /(?:^|[/\s])claude(?:-code)?(?:[/\s]|$)/;

// Walk the /proc parent chain from our launcher up to the real `claude` process.
// Hook tree is: node launcher → bash (hook shell) → claude. Returns its pid, or
// null if not found / not Linux (no /proc).
function findClaudePid(start) {
  let pid = start;
  for (let i = 0; i < 24 && pid > 1; i++) {
    let comm = '';
    try { comm = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch { return null; }
    if (CLAUDE_RE.test(comm)) return pid;
    try {
      const cl = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
      if (CLAUDE_RE.test(cl)) return pid;
    } catch {}
    // ppid = 4th field of /proc/pid/stat; comm (2nd field) may hold spaces/parens,
    // so parse the tail after the last ')'.
    let ppid = 0;
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const tail = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      ppid = parseInt(tail[1], 10); // tail[0]=state, tail[1]=ppid
    } catch { return null; }
    if (!ppid || ppid === pid) return null;
    pid = ppid;
  }
  return null;
}

function alive(pid) {
  if (!pid || Number.isNaN(pid)) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function start(sessionId) {
  // New session starting → drop any stale end marker so it isn't suppressed.
  try { fs.unlinkSync(ENDED_FILE); } catch {}

  // Record liveness PID (best-effort, Linux only).
  try {
    const pid = findClaudePid(process.ppid);
    if (pid) {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(LIVE_FILE, JSON.stringify({ sessionId, pid, ts: Date.now() }));
    }
  } catch {}

  // Already running? bail.
  if (fs.existsSync(LOCK)) {
    const pid = parseInt(fs.readFileSync(LOCK, 'utf8').trim(), 10);
    if (alive(pid)) process.exit(0);
    try { fs.unlinkSync(LOCK); } catch {}
  }

  const child = spawn(process.execPath, [path.join(__dirname, 'daemon.js')], {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
  process.exit(0);
}

// SessionStart hook pipes JSON {session_id,...} on stdin. Read it for the
// liveness marker; guard so we never hang if stdin is empty/closed.
let raw = '';
let done = false;
function go() {
  if (done) return; done = true;
  let sessionId = null;
  try { sessionId = JSON.parse(raw).session_id || null; } catch {}
  start(sessionId);
}
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', go);
setTimeout(go, 800);
