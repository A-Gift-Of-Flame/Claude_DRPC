// Single source of truth for DRPC state-file locations.
// MUST be env-independent. os.tmpdir() resolves differently between the
// long-lived daemon (spawned once with the session's sandbox TMPDIR) and later
// hook invocations (TMPDIR often unset), which split state across two dirs and
// silently broke session-end suppression + the statusline tier. Pin to ~/.claude.
const os = require('os');
const path = require('path');

const STATE_DIR = path.join(os.homedir(), '.claude', 'drpc');

module.exports = {
  STATE_DIR,
  STATUS_FILE: path.join(STATE_DIR, 'status.json'),
  ENDED_FILE: path.join(STATE_DIR, 'ended.json'),
  LIVE_FILE: path.join(STATE_DIR, 'live.json'),
  LOCK: path.join(STATE_DIR, 'daemon.lock'),
  LOG: path.join(STATE_DIR, 'daemon.log')
};
