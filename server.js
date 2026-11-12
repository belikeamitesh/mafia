'use strict';
// HTTP + Socket.IO layer. Serves the page, maps sockets to players, and forwards actions to Room (game.js).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { Room } = require('./game');

const PORT = process.env.PORT || 3000;
const ROOM_IDLE_MS = 30 * 60000; // drop rooms nobody has been connected to for this long

// One JSON line per event: easy to read and search in Render's Logs tab.
const log = (event, data = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), event, ...data }));

// ---------- static files (fixed list, read once at startup) ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const files = Object.fromEntries(['index.html', 'style.css', 'app.js'].map(f =>
  [f, { body: fs.readFileSync(path.join(__dirname, 'public', f)), type: TYPES[path.extname(f)] }]));

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/health') return res.end('ok');
  const file = files[url.slice(1)] || files['index.html']; // any other path is the app (e.g. /?room=ABCDE)
  res.writeHead(200, {
    'Content-Type': file.type,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'microphone=(self), camera=()',
  });
  res.end(file.body);
});
const io = new Server(server, { maxHttpBufferSize: 700 * 1024 }); // room for one 30s voice note

// ---------- abuse limits ----------
// Fixed-window counter: at most `max` hits per `ms` for each key.
function limiter(max, ms) {
  const hits = new Map();
  const allow = key => {
    const now = Date.now();
    let h = hits.get(key);
    if (!h || now - h.start > ms) hits.set(key, h = { start: now, n: 0 });
    return ++h.n <= max;
  };
  allow.prune = () => { const now = Date.now(); for (const [k, h] of hits) if (now - h.start > ms) hits.delete(k); };
  return allow;
}
const createLimit = limiter(20, 10 * 60000); // rooms created per IP (friends on one Wi-Fi share an IP)
const joinLimit = limiter(20, 60000);        // join attempts per connection
const actLimit = limiter(40, 10000);         // actions (chat, votes, reactions…) per connection
const clientIp = socket => String(socket.handshake.headers['x-forwarded-for'] || socket.handshake.address).split(',')[0].trim();

// ---------- rooms ----------
// ponytail: rooms live in memory; a restart or redeploy ends running games. Add Redis if that ever matters.
const rooms = new Map();
const newCode = () => { let c; do c = Array.from({ length: 5 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[crypto.randomInt(32)]).join(''); while (rooms.has(c)); return c; };
function createRoom() {
  const code = newCode();
  const r = new Room(code, (id, ev, data) => io.to('p:' + id).emit(ev, data));
  r.log = (event, data) => log(event, { room: code, ...data });
  rooms.set(code, r);
  return r;
}

io.on('connection', socket => {
  let room = null, player = null;

  socket.on('join', (a = {}, cb = () => {}) => {
    if (typeof cb !== 'function' || typeof a !== 'object' || !a) return;
    if (!joinLimit(socket.id)) return cb({ error: 'Too many attempts — wait a minute and try again.' });
    let code = String(a.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    // One room per browser: leave your current room before creating or joining another.
    const current = [...rooms.values()].find(x => x.byToken.has(a.token));
    if (current && (a.create || current.code !== code))
      return cb({ error: `You are already in room ${current.code}. Use 🚪 Leave there first to start or join another game.`, code: current.code });
    let r;
    if (a.create) {
      if (!String(a.name || '').trim()) return cb({ error: 'Enter a name.' });
      if (!createLimit(clientIp(socket))) return cb({ error: 'Too many rooms created from this network — try again in a few minutes.' });
      r = createRoom();
      code = r.code;
      log('room_created', { room: code });
    } else r = rooms.get(code);
    if (!r) return cb({ error: `Room ${code || ''} no longer exists — the game ended or the server restarted. Create a new room.`, gone: true });
    // A known token re-attaches to the same player — the same browser can never be two players.
    const res = r.join(a.token, a.name);
    if (res.error) {
      if (a.create) rooms.delete(code);
      return cb({ error: res.error, needName: !r.byToken.has(a.token) });
    }
    // Same page joining again (e.g. Create after Leave): drop the old binding only once the new join worked.
    if (player) {
      socket.leave('p:' + player.id);
      if (room.players.has(player.id)) room.disconnect(player);
    }
    room = r; player = res.player;
    socket.join('p:' + player.id);
    cb({ ok: true, code });
    room.connect(player);
    room.sendHistory(player);
  });

  socket.on('act', (a = {}) => {
    if (!room || !room.players.has(player.id) || typeof a !== 'object' || !a) return;
    if (a.type !== 'typing' && !actLimit(socket.id)) return socket.emit('toast', 'Slow down a bit!');
    try {
      room.handle(player, a.type, a);
      if (room.closed) { rooms.delete(room.code); log('room_closed', { room: room.code }); }
    } catch (e) {
      socket.emit('toast', typeof e === 'string' ? e : 'Something went wrong.');
      if (typeof e !== 'string') log('error', { room: room.code, action: a.type, message: e.message, stack: e.stack });
    }
  });

  socket.on('disconnect', () => { if (room && room.players.has(player.id)) room.disconnect(player); });
});

setInterval(() => {
  for (const [code, r] of rooms)
    if (![...r.players.values()].some(p => p.sockets) && Date.now() - r.emptySince > ROOM_IDLE_MS) {
      r.cancel(r.timer); rooms.delete(code); log('room_expired', { room: code });
    }
  createLimit.prune(); joinLimit.prune(); actLimit.prune();
}, 60000).unref();

// Render stops the old server on every deploy: warn players instead of dropping them silently.
process.on('SIGTERM', () => {
  log('shutdown', { rooms: rooms.size });
  io.emit('toast', '⚠️ The server is updating — open games will end. Create a new room in a minute.');
  setTimeout(() => process.exit(0), 1000).unref();
});

server.listen(PORT, () => log('listening', { port: PORT }));
