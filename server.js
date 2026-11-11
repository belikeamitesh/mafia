'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { Room } = require('./game');

const page = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
const server = http.createServer((req, res) => {
  if (req.url === '/health') return res.end('ok');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(page);
});
const io = new Server(server, { maxHttpBufferSize: 1e4 });

// ponytail: rooms live in memory; a server restart ends running games. Add Redis if that ever matters.
const rooms = new Map();
const newCode = () => { let c; do c = Array.from({ length: 5 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[crypto.randomInt(32)]).join(''); while (rooms.has(c)); return c; };

io.on('connection', socket => {
  let room = null, player = null;

  socket.on('join', (a = {}, cb = () => {}) => {
    if (typeof cb !== 'function' || player) return;
    let code = String(a.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    if (a.create) { code = newCode(); rooms.set(code, new Room(code, (id, ev, data) => io.to('p:' + id).emit(ev, data))); }
    const r = rooms.get(code);
    if (!r) return cb({ error: 'Room not found. Check the code or create a new room.' });
    // A known token re-attaches to the same player — the same browser can never be two players.
    const res = r.join(a.token, a.name);
    if (res.error) return cb({ error: res.error, needName: !r.byToken.has(a.token) });
    room = r; player = res.player;
    socket.join('p:' + player.id);
    cb({ ok: true, code });
    room.connect(player);
    room.sendHistory(player);
  });

  socket.on('act', (a = {}) => {
    if (!room || !room.players.has(player.id)) return;
    try { room.handle(player, a.type, a); }
    catch (e) { socket.emit('toast', typeof e === 'string' ? e : 'Something went wrong.'); if (typeof e !== 'string') console.error(e); }
  });

  socket.on('disconnect', () => { if (room && room.players.has(player.id)) room.disconnect(player); });
});

// Drop rooms nobody has been connected to for 30 minutes.
setInterval(() => {
  for (const [code, r] of rooms)
    if (![...r.players.values()].some(p => p.sockets) && Date.now() - r.emptySince > 30 * 60000) { r.cancel(r.timer); rooms.delete(code); }
}, 60000);

const port = process.env.PORT || 3000;
server.listen(port, () => console.log(`Mafia running on http://localhost:${port}`));
