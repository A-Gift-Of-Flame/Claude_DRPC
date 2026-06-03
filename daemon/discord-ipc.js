// Minimal Discord IPC (Rich Presence) client. No dependencies.
// Frame format: [opcode int32 LE][length int32 LE][utf8 JSON payload]
const net = require('net');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };

function ipcCandidatePaths() {
  const bases = [
    process.env.XDG_RUNTIME_DIR,
    process.env.TMPDIR,
    process.env.TMP,
    process.env.TEMP,
    '/tmp'
  ].filter(Boolean);
  // plain, snap, flatpak install layouts
  const prefixes = ['', 'snap.discord/', 'app/com.discordapp.Discord/'];
  const out = [];
  for (const b of bases)
    for (const p of prefixes)
      for (let i = 0; i < 10; i++)
        out.push(path.join(b, `${p}discord-ipc-${i}`));
  return [...new Set(out)];
}

class DiscordIPC {
  constructor(clientId) {
    this.clientId = clientId;
    this.socket = null;
    this.connected = false;
    this._buf = Buffer.alloc(0);
    this._readyResolve = null;
    this.onClose = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const paths = ipcCandidatePaths();
      const tryNext = (i) => {
        if (i >= paths.length) return reject(new Error('no Discord IPC socket found'));
        const p = paths[i];
        if (!fs.existsSync(p)) return tryNext(i + 1);
        const sock = net.createConnection(p);
        sock.once('error', () => tryNext(i + 1));
        sock.once('connect', () => {
          this.socket = sock;
          this._readyResolve = resolve;
          sock.removeAllListeners('error');
          sock.on('error', () => this._down());
          sock.on('close', () => this._down());
          sock.on('data', (d) => this._onData(d));
          this._send(OP.HANDSHAKE, { v: 1, client_id: this.clientId });
        });
      };
      tryNext(0);
    });
  }

  _down() {
    if (this.connected || this.socket) {
      this.connected = false;
      this.socket = null;
      if (this.onClose) this.onClose();
    }
  }

  _send(op, payload) {
    if (!this.socket) return;
    const body = Buffer.from(JSON.stringify(payload));
    const head = Buffer.alloc(8);
    head.writeInt32LE(op, 0);
    head.writeInt32LE(body.length, 4);
    this.socket.write(Buffer.concat([head, body]));
  }

  _onData(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    while (this._buf.length >= 8) {
      const op = this._buf.readInt32LE(0);
      const len = this._buf.readInt32LE(4);
      if (this._buf.length < 8 + len) break;
      const raw = this._buf.slice(8, 8 + len).toString();
      this._buf = this._buf.slice(8 + len);
      let msg = {};
      try { msg = JSON.parse(raw); } catch {}
      if (op === OP.PING) { this._send(OP.PONG, msg); continue; }
      if (op === OP.CLOSE) { this.socket && this.socket.end(); continue; }
      if (msg.evt === 'READY') {
        this.connected = true;
        if (this._readyResolve) { this._readyResolve(); this._readyResolve = null; }
      }
    }
  }

  setActivity(activity) {
    if (!this.connected) return;
    this._send(OP.FRAME, {
      cmd: 'SET_ACTIVITY',
      args: { pid: process.pid, activity },
      nonce: randomUUID()
    });
  }

  clear() { this.setActivity(null); }

  destroy() {
    try { this.socket && this.socket.destroy(); } catch {}
    this.connected = false;
    this.socket = null;
  }
}

module.exports = { DiscordIPC };
