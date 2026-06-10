#!/usr/bin/env node
// Persistent, passive Discord Rich Presence daemon for Claude Code.
// Watches ~/.claude/projects/*/*.jsonl (+ optional statusline state) and pushes
// presence to Discord. Self-exits when idle. Never touches the model = 0 tokens.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DiscordIPC } = require('./discord-ipc');
const { STATE_DIR, STATUS_FILE, ENDED_FILE, LIVE_FILE, LOCK, LOG } = require('./paths');

const cfg = loadConfig();
const CLIENT_ID = process.env.CLAUDE_DRPC_CLIENT_ID || cfg.clientId;
const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const POLL_MS = 5000;
const IDLE_EXIT_MS = (cfg.idleExitMinutes || 10) * 60000;
const MAX_PARSE_BYTES = 8 * 1024 * 1024; // skip token recompute past this

let ipc = null;
let sessionStart = Date.now();
let lastActiveTs = Date.now();
let reconnectBlockedUntil = 0;

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8')); }
  catch { return {}; }
}
function log(...a) {
  if (!cfg.debug) return;
  try { fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${a.join(' ')}\n`); } catch {}
}

// ---- model + formatting helpers ------------------------------------------
function modelFamily(id) {
  if (!id) return null;
  if (/fable/i.test(id)) return 'fable';
  if (/opus/i.test(id)) return 'opus';
  if (/sonnet/i.test(id)) return 'sonnet';
  if (/haiku/i.test(id)) return 'haiku';
  return null;
}
function modelLabel(id) {
  const f = modelFamily(id);
  return f ? f[0].toUpperCase() + f.slice(1) : (id || 'Claude');
}
function fmtTokens(n) {
  if (!n) return '';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M tok';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k tok';
  return n + ' tok';
}
function fmtCost(n) {
  return typeof n === 'number' && n > 0 ? '$' + n.toFixed(2) : '';
}

// ---- data sources --------------------------------------------------------
function newestTranscript() {
  let best = null, bestM = 0;
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS); } catch { return null; }
  for (const d of dirs) {
    const dp = path.join(PROJECTS, d);
    let files = [];
    try { files = fs.readdirSync(dp); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const fp = path.join(dp, f);
      let st; try { st = fs.statSync(fp); } catch { continue; }
      if (st.mtimeMs > bestM) { bestM = st.mtimeMs; best = { file: fp, mtime: st.mtimeMs, size: st.size }; }
    }
  }
  return best;
}

// SessionEnd marker: written by session-end.js on /exit (clean quit). Lets the
// daemon stop counting immediately instead of waiting out the idle window.
function readEnded() {
  try { return JSON.parse(fs.readFileSync(ENDED_FILE, 'utf8')); } catch { return null; }
}

// Liveness marker: written by launcher.js, pins a session to the live `claude`
// PID. Lets us detect a dirty terminal kill (SIGHUP, which never fires
// SessionEnd) immediately instead of waiting out the idle window.
function readLive() {
  try { return JSON.parse(fs.readFileSync(LIVE_FILE, 'utf8')); } catch { return null; }
}
// True unless we can prove the process is gone. Unknown pid → true (don't
// suppress). On Linux we also verify /proc comm/cmdline to defeat PID reuse.
// Matches `claude` without matching the `.claude` config-dir path (see launcher).
const CLAUDE_RE = /(?:^|[/\s])claude(?:-code)?(?:[/\s]|$)/;
function pidAlive(pid) {
  if (!pid) return true;
  try { process.kill(pid, 0); } catch { return false; }
  try {
    if (!CLAUDE_RE.test(fs.readFileSync(`/proc/${pid}/comm`, 'utf8'))
      && !CLAUDE_RE.test(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' '))) return false;
  } catch {} // non-Linux or unreadable → trust process.kill
  return true;
}

// Statusline tier: Claude's own model/cost numbers, written by statusline.js.
function readStatus() {
  try {
    const st = fs.statSync(STATUS_FILE);
    if (Date.now() - st.mtimeMs > IDLE_EXIT_MS) return null;
    return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
  } catch { return null; }
}

// Tally tokens + (fallback) cost from transcript usage records.
// tokens (display): new work only = input + output + cache_creation. cache_read
// is the SAME context re-read every turn; summing it N-counts and balloons the
// number, so it's excluded from the display total (still billed in `cost`).
function tallyFromTranscript(entries) {
  const p = cfg.pricing || {};
  let tokens = 0, cost = 0, lastModel = null;
  for (const e of entries) {
    if (e.type !== 'assistant' || !e.message) continue;
    if (e.message.model) lastModel = e.message.model;
    const u = e.message.usage;
    if (!u) continue;
    const inp = u.input_tokens || 0;
    const out = u.output_tokens || 0;
    const cw = u.cache_creation_input_tokens || 0;
    const cr = u.cache_read_input_tokens || 0;
    tokens += inp + out + cw; // exclude cache_read from displayed count
    const pr = p[modelFamily(e.message.model)];
    if (pr) cost += (inp * pr.input + out * pr.output + cw * pr.cacheWrite + cr * pr.cacheRead) / 1e6;
  }
  return { tokens, cost, lastModel };
}

function parseLines(file, size) {
  let txt = '';
  try { txt = fs.readFileSync(file, 'utf8'); } catch { return []; }
  return txt.split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

// Returns an activity object, or null when there is no recent activity.
function computeActivity() {
  const t = newestTranscript();
  if (!t) return null;
  if (Date.now() - t.mtime > IDLE_EXIT_MS) return null; // stale session

  const entries = parseLines(t.file, t.size);

  let cwd, branch, lastTool, lastType, firstTs, lastTs, sessionId;
  for (const e of entries) {
    if (e.timestamp) { const ms = Date.parse(e.timestamp); if (ms) { if (!firstTs) firstTs = ms; lastTs = ms; } }
    if (e.sessionId) sessionId = e.sessionId;
    if (e.cwd) cwd = e.cwd;
    if (e.gitBranch && e.gitBranch !== 'HEAD') branch = e.gitBranch;
    if (e.type === 'user' || e.type === 'assistant') {
      lastType = e.type;
      if (e.type === 'assistant' && e.message && Array.isArray(e.message.content)) {
        for (const c of e.message.content) if (c.type === 'tool_use') lastTool = c.name;
      }
    }
  }

  // Clean /exit on this session → stop reporting it (no idle-window tail).
  const ended = readEnded();
  if (ended && ended.sessionId && ended.sessionId === sessionId) return null;

  // Dirty kill: the session's claude process is gone but no SessionEnd fired.
  // If the liveness marker matches this session and its PID is dead, stop now.
  const live = readLive();
  if (live && live.sessionId && live.sessionId === sessionId && !pidAlive(live.pid)) return null;

  const tally = t.size <= MAX_PARSE_BYTES
    ? tallyFromTranscript(entries)
    : { tokens: 0, cost: 0, lastModel: null };

  // statusline tier wins for model + cost (Claude's exact numbers) — but ONLY
  // when it belongs to the SAME session as the active transcript. status.json is
  // a single global file, overwritten by whichever session last rendered its
  // statusline; a stale entry from another session would otherwise bleed the
  // wrong project/model/cost into this session's presence.
  const status = readStatus();
  const statusMatch = status && status.session_id && status.session_id === sessionId;
  const model = (statusMatch && status.model && status.model.display_name) || modelLabel(tally.lastModel);
  const cost = (statusMatch && status.cost && typeof status.cost.total_cost_usd === 'number')
    ? status.cost.total_cost_usd
    : tally.cost;
  if (statusMatch && status.workspace && status.workspace.current_dir) cwd = status.workspace.current_dir;

  const project = cwd ? path.basename(cwd) : 'Claude Code';
  let activity;
  if (lastType === 'assistant' && lastTool) activity = `Using ${lastTool}`;
  else if (lastType === 'user') activity = 'Thinking…';
  else activity = 'Coding';

  const details = branch ? `${project} · ${branch}` : project;
  // 'Claude' is the no-data fallback label — skip it rather than show a non-answer
  const extras = [model !== 'Claude' ? model : '', fmtTokens(tally.tokens), fmtCost(cost)].filter(Boolean).join(' · ');
  const state = (extras ? `${activity} · ${extras}` : activity).slice(0, 128);

  const assets = {
    large_image: cfg.largeImage || 'claude',
    large_text: (`Claude Code · ${model}`).slice(0, 128)
  };
  if (cfg.smallImage) {
    assets.small_image = cfg.smallImage;
    assets.small_text = model.slice(0, 128);
  }

  const start = firstTs || sessionStart;
  return { state, details: details.slice(0, 128), timestamps: { start }, assets, sessionId, lastTs };
}

// ---- discord plumbing ----------------------------------------------------
async function ensureConnected() {
  if (ipc && ipc.connected) return true;
  if (Date.now() < reconnectBlockedUntil) return false;
  ipc = new DiscordIPC(CLIENT_ID);
  ipc.onClose = () => log('discord socket closed');
  try { await ipc.connect(); log('connected to discord'); return true; }
  catch (e) { reconnectBlockedUntil = Date.now() + 15000; log('connect failed:', e.message); return false; }
}

async function tick() {
  const act = computeActivity();
  if (act === null) {
    if (Date.now() - lastActiveTs > IDLE_EXIT_MS) { log('idle, exiting'); return shutdown(); }
    if (ipc && ipc.connected) ipc.clear();
    return;
  }
  lastActiveTs = Date.now();
  if (await ensureConnected()) ipc.setActivity(act);
}

// Only remove the lock if it's still ours — never orphan a sibling daemon.
function releaseLock() {
  try {
    if (parseInt(fs.readFileSync(LOCK, 'utf8').trim(), 10) === process.pid) fs.unlinkSync(LOCK);
  } catch {}
}

function shutdown() {
  try { if (ipc) { ipc.clear(); ipc.destroy(); } } catch {}
  releaseLock();
  process.exit(0);
}

if (!CLIENT_ID || CLIENT_ID === 'YOUR_DISCORD_APP_CLIENT_ID') {
  log('no clientId; set config.json clientId or CLAUDE_DRPC_CLIENT_ID. exiting.');
  process.exit(0);
}

fs.mkdirSync(STATE_DIR, { recursive: true });
fs.writeFileSync(LOCK, String(process.pid));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('exit', releaseLock);

log('daemon started pid', process.pid);
setInterval(tick, POLL_MS);
tick();
