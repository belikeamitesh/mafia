// Rule + edge-case checks: node test.js
const assert = require('assert');
const { Room, roleCounts, topVoted } = require('./game');

let passed = 0;
const t = (name, fn) => { try { fn(); passed++; } catch (e) { console.error('✗ ' + name); throw e; } };
const throws = (fn, re) => assert.throws(fn, e => re.test(String(e)));

// Room with a fake clock: timers are captured instead of run.
function room() {
  const sent = [], timer = {};
  const r = new Room('T', (id, ev, d) => sent.push({ id, ev, d }), (fn, ms) => Object.assign(timer, { fn, ms }), () => {});
  return { r, sent, timer };
}
// Start a game and force a known role layout, e.g. game('MPDVV').
function game(layout) {
  const ctx = room(), { r } = ctx;
  const ps = [...layout].map((_, i) => { const p = r.join('token-player-' + i, 'P' + i).player; r.connect(p); return p; });
  r.start();
  const code = { M: 'mafia', P: 'police', D: 'doctor', V: 'villager' };
  ps.forEach((p, i) => { p.role = code[layout[i]]; });
  r.counts = { mafia: 0, police: 0, doctor: 0, villager: 0 };
  ps.forEach(p => r.counts[p.role]++);
  ctx.sent.length = 0;
  return { ...ctx, ps };
}
const roleWords = /\b(doctor|police|villager)\b/i;

// ---------- role distribution ----------
t('role counts by player count', () => {
  const c = n => Object.values(roleCounts(n));
  assert.deepStrictEqual(c(4), [1, 0, 0, 3]);
  assert.deepStrictEqual(c(5), [1, 1, 0, 3]);
  assert.deepStrictEqual(c(6), [1, 1, 1, 3]);
  assert.deepStrictEqual(c(9), [2, 1, 1, 5]);
  assert.deepStrictEqual(c(10), [2, 2, 1, 5]);
  assert.deepStrictEqual(c(13), [3, 2, 1, 7]);
  assert.deepStrictEqual(c(14), [3, 2, 2, 7]);
  assert.deepStrictEqual(c(30), [7, 2, 2, 19]);
  for (let n = 4; n <= 60; n++) {
    const k = roleCounts(n);
    assert.strictEqual(k.mafia + k.police + k.doctor + k.villager, n);
    assert.ok(k.mafia < n - k.mafia, `mafia must start as a minority (n=${n})`);
    assert.ok(k.doctor <= 2 && k.police <= 2);
  }
});
t('start deals exactly the planned roles', () => {
  for (const n of [4, 5, 6, 10, 13, 14, 25]) {
    const { r } = room();
    for (let i = 0; i < n; i++) r.connect(r.join('token-deal-' + i, 'D' + i).player);
    r.start();
    const got = {}; for (const p of r.players.values()) got[p.role] = (got[p.role] || 0) + 1;
    const want = roleCounts(n); for (const k in want) if (!want[k]) delete want[k];
    assert.deepStrictEqual(got, want);
  }
});
t('topVoted handles ties and ignored values', () => {
  assert.deepStrictEqual(topVoted(new Map([[1, 'a'], [2, 'b']])).top.sort(), ['a', 'b']);
  assert.deepStrictEqual(topVoted(new Map([[1, 'skip'], [2, 'skip'], [3, 'a']]), 'skip'), { top: ['a'], count: 1 });
  assert.deepStrictEqual(topVoted(new Map()).top, []);
});

// ---------- joining / lobby ----------
t('names: required, unique (any case), trimmed, sanitized, max 16', () => {
  const { r } = room();
  assert.match(r.join('token-aaaaaaaa', '   ').error, /name/);
  const a = r.join('token-aaaaaaaa', '  Ann  ').player;
  assert.strictEqual(a.name, 'Ann');
  assert.match(r.join('token-bbbbbbbb', 'aNN').error, /taken/);
  assert.strictEqual(r.join('token-cccccccc', '<b>Bob</b>\u0007').player.name, 'bBob/b');
  assert.strictEqual(r.join('token-dddddddd', 'x'.repeat(50)).player.name.length, 16);
  assert.match(r.join('short', 'Zed').error, /session/);
});
t('same browser token = same player (no double join)', () => {
  const { r } = room();
  const a = r.join('token-aaaaaaaa', 'Ann').player;
  assert.strictEqual(r.join('token-aaaaaaaa', 'Other').player, a);
  assert.strictEqual(r.players.size, 1);
});
t('start needs host and 4 online players; offline players sit out', () => {
  const { r } = room();
  const ps = [0, 1, 2, 3, 4].map(i => r.join('token-s-' + i + 'xxxx', 'S' + i).player);
  ps.slice(0, 3).forEach(p => r.connect(p));
  throws(() => r.handle(ps[1], 'start'), /host/);
  throws(() => r.start(), /at least 4/);
  r.connect(ps[3]);
  r.handle(ps[0], 'start');
  assert.ok(ps[4].spectator && ps[4].role === null, 'offline player should not get a role');
  throws(() => r.start(), /already running/);
});
t('room locks once the game starts; existing players can still reconnect', () => {
  const { r, ps } = game('MVVV');
  assert.match(r.join('token-latexxxx', 'Late').error, /locked/);
  assert.strictEqual(r.join('token-player-2', '').player, ps[2]);
  r.endNight(); assert.match(r.join('token-latexxxx', 'Late').error, /locked/);
  r.remove(ps[0], 'left the game');           // game over -> room opens again
  assert.ok(r.join('token-latexxxx', 'Late').player);
});
t('player offline at start sits out: no vote, no action, no town chat, graveyard ok', () => {
  const { r } = room();
  const ps = [0, 1, 2, 3, 4].map(i => r.join('token-o-' + i + 'xxxx', 'O' + i).player);
  ps.slice(0, 4).forEach(p => r.connect(p));
  r.start(); r.connect(ps[4]);
  const off = ps[4], alive = ps.find(p => p.role === 'villager');
  assert.ok(off.spectator);
  throws(() => r.nightAction(off, alive.id), /Dead|cannot act/);
  r.endNight();
  if (r.phase === 'day') throws(() => r.vote(off, alive.id), /Dead/);
  throws(() => r.chat(off, 'public', 'hi'), /out|dead/);
  r.chat(off, 'dead', 'watching');
});
t('host Stop: host only, ends game for everyone', () => {
  const { r, ps } = game('MPDVVV');
  throws(() => r.handle(ps[1], 'stop'), /host/);
  r.handle(ps[0], 'stop');
  assert.strictEqual(r.phase, 'lobby');
  assert.ok([...r.players.values()].every(p => !p.role));
});
t('settings: host only, clamped, locked during game', () => {
  const { r } = room();
  const h = r.join('token-hostxxxx', 'H').player, o = r.join('token-othrxxxx', 'O').player;
  throws(() => r.handle(o, 'settings', { dayMinutes: 3 }), /host/);
  r.handle(h, 'settings', { dayMinutes: 99, nightSeconds: 1 });
  assert.deepStrictEqual(r.settings, { dayMinutes: 10, nightSeconds: 20 });
  r.handle(h, 'settings', { dayMinutes: 'abc', nightSeconds: 45 });
  assert.deepStrictEqual(r.settings, { dayMinutes: 5, nightSeconds: 45 });
  const g = game('MVVV');
  throws(() => g.r.handle(g.ps[0], 'settings', { dayMinutes: 2 }), /between games/);
});

// ---------- privacy ----------
t('villager/doctor see only their own role', () => {
  const { r, ps } = game('MMPPDVVVVV');
  for (const p of ps.filter(p => p.role === 'villager' || p.role === 'doctor'))
    assert.ok(r.view(p).players.every(q => q.id === p.id ? q.role === p.role : q.role === null));
});
t('mafia see mafia; police (2) see police; nobody else', () => {
  const { r, ps } = game('MMPPDVVVVV');
  for (const team of ['mafia', 'police']) for (const p of ps.filter(p => p.role === team)) {
    const seen = r.view(p).players.filter(q => q.role).map(q => q.role);
    assert.deepStrictEqual([...new Set(seen)], [team]);
    assert.strictEqual(seen.length, 2);
  }
});
t('team chats: mafia always, police only with 2 officers, none for doctor/villagers', () => {
  const big = game('MMPPDVVVVV');
  const [m1, , c1, , d, v] = big.ps;
  assert.ok(big.r.canRead(m1, 'mafia') && !big.r.canRead(c1, 'mafia') && !big.r.canRead(v, 'mafia'));
  assert.ok(big.r.canRead(c1, 'police') && !big.r.canRead(m1, 'police') && !big.r.canRead(d, 'police'));
  big.r.chat(c1, 'police', 'I will check P0');
  big.r.chat(m1, 'mafia', 'kill P2');
  const gotPolice = big.sent.filter(s => s.ev === 'msg' && s.d.ch === 'police').map(s => s.id).sort();
  const gotMafia = big.sent.filter(s => s.ev === 'msg' && s.d.ch === 'mafia').map(s => s.id).sort();
  assert.deepStrictEqual(gotPolice, [big.ps[2].id, big.ps[3].id].sort());
  assert.deepStrictEqual(gotMafia, [big.ps[0].id, big.ps[1].id].sort());
  const small = game('MPDVVV');
  throws(() => small.r.chat(small.ps[1], 'police', 'hi'), /cannot post/);
  assert.ok(!small.r.view(small.ps[1]).me.canRead.police);
  throws(() => small.r.chat(small.ps[2], 'doctor', 'hi'), /cannot post/);
});
t('team chats stay secret after game over and in the next game', () => {
  const { r, ps } = game('MVVV');
  r.chat(ps[0], 'mafia', 'secret plan');
  ps.slice(1).forEach(p => r.remove(p, 'left'));
  ps.forEach(p => assert.ok(!r.canRead(p, 'mafia') || p.role === 'mafia' && r.phase !== 'ended'));
  assert.ok(r.messages.some(m => m.ch === 'mafia'));
  const g2 = game('MVVV'); g2.r.messages.push(...r.messages); g2.r.start === g2.r.start;
  // new game drops old private chats
  const { r: r3 } = room(); const qs = [0, 1, 2, 3].map(i => { const p = r3.join('token-q' + i + 'xxxxxx', 'Q' + i).player; r3.connect(p); return p; });
  r3.start(); const mafia = qs.find(p => p.role === 'mafia');
  r3.chat(mafia, 'mafia', 'old secret');
  r3.handle(qs[0], 'lobby'); r3.start();
  assert.ok(!r3.messages.some(m => m.text === 'old secret'));
});
t('deaths reveal only Mafia / not Mafia — never doctor or police', () => {
  const { r, ps, sent } = game('MPDVVV');
  const [m, c, d] = ps;
  const from = r.messages.length; // role counts at game start are public on purpose
  r.nightAction(m, d.id); r.endNight();           // doctor dies
  r.vote(m, c.id); r.vote(ps[3], c.id); r.endDay(); // police voted out
  assert.ok(!d.alive && !c.alive);
  const publicText = [...r.messages.slice(from).filter(x => x.ch === 'public' && !/^🌙 Night/.test(x.text)).map(x => x.text),
    ...sent.filter(s => s.ev === 'announce' && s.d.kind !== 'role').map(s => JSON.stringify(s.d))].join('\n');
  assert.ok(!roleWords.test(publicText), 'leaked a role: ' + publicText.match(roleWords));
  const seen = r.view(ps[4]).players;
  assert.strictEqual(seen.find(q => q.id === d.id).role, 'town');
  assert.strictEqual(seen.find(q => q.id === c.id).role, 'town');
});
t('only the police get investigation results', () => {
  const { r, ps, sent } = game('MPDVVV');
  r.nightAction(ps[1], ps[0].id); r.endNight();
  const inv = sent.filter(s => s.ev === 'announce' && s.d.kind === 'investigate');
  assert.deepStrictEqual(inv.map(s => s.id), [ps[1].id]);
  assert.strictEqual(inv[0].d.mafia, true);
  assert.strictEqual(r.view(ps[3]).players.find(q => q.id === ps[0].id).role, null);
});
t('2 police: separate checks, shared results, cannot check each other', () => {
  const { r, ps } = game('MMPPDVVVVV');
  const [m1, , c1, c2] = ps;
  throws(() => r.nightAction(c1, c2.id), /partner/);
  throws(() => r.nightAction(c1, c1.id), /own role/);
  r.nightAction(c1, m1.id); r.nightAction(c2, ps[5].id);
  r.endNight();
  for (const c of [c1, c2]) assert.deepStrictEqual(c.results.map(x => [x.name, x.mafia]), [['P0', true], ['P5', false]]);
});
t('dead officer gets no new check but still sees partner results', () => {
  const { r, ps } = game('MMPPDVVVVV');
  const [m1, m2, c1, c2] = ps;
  r.nightAction(m1, c1.id); r.nightAction(m2, c1.id); r.endNight();
  assert.ok(!c1.alive);
  r.endDay();
  throws(() => r.nightAction(c1, m1.id), /Dead/);
  r.nightAction(c2, m2.id); r.endNight();
  assert.strictEqual(c1.results.length, 1);
});

// ---------- night ----------
t('night action validation', () => {
  const { r, ps } = game('MPDVVV');
  const [m, c, d, v] = ps;
  throws(() => r.nightAction(m, m.id), /fellow/);
  throws(() => r.nightAction(v, m.id), /sleep/);
  throws(() => r.nightAction(m, 'nope'), /living/);
  throws(() => r.vote(v, m.id), /day/);
  r.nightAction(d, d.id);                      // self-save allowed
  r.nightAction(m, d.id); r.endNight();
  assert.ok(d.alive, 'self-save failed');
  r.endDay();
  throws(() => r.nightAction(d, d.id), /two nights/);
  r.nightAction(d, v.id);                      // different target ok
  r.endNight(); r.endDay();
  r.nightAction(d, d.id);                      // self again after a gap ok
});
t('doctor who skips a night may save anyone next night', () => {
  const { r, ps } = game('MPDVVV');
  const d = ps[2];
  r.nightAction(d, ps[3].id); r.endNight(); r.endDay();
  r.endNight(); r.endDay();                   // doctor did nothing
  r.nightAction(d, ps[3].id);
});
t('no mafia vote = nobody dies; changing/clearing a pick works', () => {
  const { r, ps } = game('MPDVVV');
  r.nightAction(ps[0], ps[3].id); r.nightAction(ps[0], null); r.endNight();
  assert.ok(ps.every(p => p.alive));
  r.endDay();
  r.nightAction(ps[0], ps[3].id); r.nightAction(ps[0], ps[4].id); r.endNight();
  assert.ok(ps[3].alive && !ps[4].alive);
});
t('mafia split vote picks one of the tied targets', () => {
  for (let i = 0; i < 20; i++) {
    const { r, ps } = game('MMPDVVVV');
    r.nightAction(ps[0], ps[4].id); r.nightAction(ps[1], ps[5].id); r.endNight();
    assert.strictEqual([ps[4], ps[5]].filter(p => !p.alive).length, 1);
  }
});
t('mafia majority wins over a lone pick', () => {
  const { r, ps } = game('MMMPDVVVVVVV');
  r.nightAction(ps[0], ps[5].id); r.nightAction(ps[1], ps[5].id); r.nightAction(ps[2], ps[6].id); r.endNight();
  assert.ok(!ps[5].alive && ps[6].alive);
});
t('night ends early once every living role acted', () => {
  const { r, ps, timer } = game('MPDVVV');
  r.nightAction(ps[0], ps[3].id); r.nightAction(ps[1], ps[0].id);
  assert.notStrictEqual(timer.ms, 3000);
  r.nightAction(ps[2], ps[4].id);
  assert.strictEqual(timer.ms, 3000);
  timer.fn();
  assert.strictEqual(r.phase, 'day');
});
t('stale timers are no-ops', () => {
  const { r } = game('MPDVVV');
  r.endNight(); const round = r.round;
  r.endNight();
  assert.strictEqual(r.phase, 'day'); assert.strictEqual(r.round, round);
  r.endDay(); r.endDay();
  assert.strictEqual(r.phase, 'night');
});

// ---------- day ----------
t('vote validation', () => {
  const { r, ps } = game('MPDVVV');
  r.nightAction(ps[0], ps[5].id); r.endNight();
  throws(() => r.vote(ps[1], ps[1].id), /yourself/);
  throws(() => r.vote(ps[1], ps[5].id), /living/);
  throws(() => r.vote(ps[5], ps[0].id), /Dead/);
  throws(() => r.nightAction(ps[0], ps[1].id), /night/);
  r.vote(ps[1], ps[0].id); r.vote(ps[1], ps[2].id); r.vote(ps[1], null);
  assert.ok(!r.votes.has(ps[1].id));
});
const dayCase = (votes, expectOut) => {
  const { r, ps } = game('MPDVVVVV');
  r.endNight();
  votes.forEach(([from, to]) => r.vote(ps[from], to === 'skip' ? 'skip' : ps[to].id));
  r.endDay();
  const out = ps.findIndex(p => !p.alive);
  assert.strictEqual(out === -1 ? null : out, expectOut);
};
t('plurality wins', () => dayCase([[1, 0], [2, 0], [3, 4]], 0));
t('tie = nobody out', () => dayCase([[1, 0], [2, 3]], null));
t('skip beats top = nobody out', () => dayCase([[1, 0], [2, 'skip'], [3, 'skip']], null));
t('skip equal to top = nobody out', () => dayCase([[1, 0], [2, 'skip']], null));
t('no votes = nobody out', () => dayCase([], null));
t('voted-out reveal says Mafia or not', () => {
  const { r, ps } = game('MPDVVVVV');
  r.endNight(); ps.slice(1, 5).forEach(p => r.vote(p, ps[5].id)); r.endDay();
  assert.match(r.messages.at(-2).text, /P5 was voted out .* NOT Mafia/);
});
t('everyone voted = 15s grace; nobody can stretch it', () => {
  const { r, ps, timer } = game('MPDVVV');
  r.endNight();
  assert.strictEqual(timer.ms, 5 * 60000);
  ps.forEach((p, i) => r.vote(p, ps[(i + 1) % 6].id));
  assert.strictEqual(timer.ms, 15000);
});
t('votes of a player who leaves mid-day are dropped', () => {
  const { r, ps } = game('MMPDVVVVV');
  r.endNight();
  r.vote(ps[0], ps[4].id); r.vote(ps[1], ps[4].id); r.vote(ps[5], ps[0].id);
  r.remove(ps[1], 'left the game');
  r.endDay();
  assert.ok(ps[4].alive, 'counted a vote from a player who left');
});

// ---------- win conditions ----------
t('town wins when last mafia is voted out', () => {
  const { r, ps } = game('MPDVVV');
  r.endNight(); ps.slice(1).forEach(p => r.vote(p, ps[0].id)); r.endDay();
  assert.strictEqual(r.winner, 'town'); assert.strictEqual(r.phase, 'ended');
});
t('mafia wins at parity after a night kill (game ends before day)', () => {
  const { r, ps } = game('MMVVV');
  r.nightAction(ps[0], ps[2].id); r.nightAction(ps[1], ps[2].id); r.endNight();
  assert.strictEqual(r.winner, 'mafia'); assert.strictEqual(r.phase, 'ended');
});
t('mafia wins at parity after a wrong vote', () => {
  const { r, ps } = game('MVVV');
  r.nightAction(ps[0], ps[1].id); r.endNight();
  r.vote(ps[2], ps[3].id); r.vote(ps[0], ps[3].id); r.endDay();
  assert.strictEqual(r.winner, 'mafia');
});
t('last mafia leaving = town wins; ended game rejects actions', () => {
  const { r, ps } = game('MPDVVV');
  r.remove(ps[0], 'left the game');
  assert.strictEqual(r.winner, 'town');
  throws(() => r.vote(ps[1], ps[2].id), /day/);
  throws(() => r.nightAction(ps[1], ps[2].id), /night/);
});
t('roles all revealed at game over', () => {
  const { r, ps } = game('MPDVVV');
  r.remove(ps[0], 'left the game');
  assert.ok(r.view(ps[3]).players.every(q => q.role));
});

// ---------- chat ----------
t('chat rules by phase and life', () => {
  const { r, ps, timer } = game('MPDVVV');
  const [m, , , v] = ps;
  throws(() => r.chat(v, 'public', 'hi'), /asleep/);
  r.chat(m, 'mafia', 'night plan');
  r.nightAction(m, v.id); timer.fn = null; r.endNight();
  throws(() => r.chat(v, 'public', 'hi'), /dead/);
  r.chat(v, 'dead', 'boo');
  assert.ok(!r.canRead(ps[4], 'dead') && r.canRead(v, 'dead'));
  ps[4].lastMsgAt = 0; r.chat(ps[4], 'public', 'day talk');
  m.lastMsgAt = 0; r.chat(m, 'mafia', 'day whisper');
  r.chat(ps[4], 'public', '   ');             // ignored, no throw, no rate-limit hit
  ps[5].lastMsgAt = 0; r.chat(ps[5], 'public', 'x'.repeat(1000));
  assert.strictEqual(r.messages.at(-1).text.length, 400);
  throws(() => r.chat(ps[5], 'public', 'spam'), /Slow down/);
});
t('reactions: toggle, allowed emoji only, dead cannot react in town', () => {
  const { r, ps } = game('MPDVVV');
  r.nightAction(ps[0], ps[3].id); r.endNight();
  r.chat(ps[4], 'public', 'sus');
  const id = r.messages.at(-1).id;
  r.react(ps[5], id, '😂'); assert.deepStrictEqual(r.messages.at(-1).reactions, { '😂': [ps[5].id] });
  r.react(ps[5], id, '😂'); assert.deepStrictEqual(r.messages.at(-1).reactions, {});
  r.react(ps[5], id, '💩'); assert.deepStrictEqual(r.messages.at(-1).reactions, {});
  throws(() => r.react(ps[3], id, '😂'), /cannot react/);
});
t('typing indicator only goes to people who can read that channel', () => {
  const { r, ps, sent } = game('MMPDVVVV');
  r.typing(ps[0], 'mafia');
  assert.deepStrictEqual(sent.filter(s => s.ev === 'typing').map(s => s.id), [ps[1].id]);
});

// ---------- leaving / host ----------
t('leaving in lobby removes; host passes to next online player', () => {
  const { r } = room();
  const a = r.join('token-aaaaaaaa', 'A').player, b = r.join('token-bbbbbbbb', 'B').player;
  r.connect(a); r.connect(b);
  r.handle(a, 'leave');
  assert.ok(!r.players.has(a.id)); assert.strictEqual(r.hostId, b.id);
  assert.match(r.join('token-aaaaaaaa', 'A').player.id, /./); // can come back as new player
});
t('room creator stays host through disconnects; only leaving passes it on', () => {
  const { r } = room();
  const a = r.join('token-aaaaaaaa', 'A').player, b = r.join('token-bbbbbbbb', 'B').player;
  r.connect(a); r.connect(b);
  r.disconnect(a); assert.strictEqual(r.hostId, a.id);
  r.connect(a); assert.strictEqual(r.hostId, a.id);
  r.handle(a, 'leave'); assert.strictEqual(r.hostId, b.id);
});
t('2 doctors: both saves count, own no-repeat rule, private Doctors chat', () => {
  const { r, ps } = game('MMMPPDDVVVVVVV');
  const [m1, m2, m3, , , d1, d2] = ps;
  assert.ok(r.canRead(d1, 'doctor') && !r.canRead(ps[3], 'doctor') && !r.canRead(m1, 'doctor'));
  r.chat(d1, 'doctor', 'I take P8');
  r.nightAction(d1, ps[8].id); r.nightAction(d2, ps[9].id);
  r.nightAction(m1, ps[9].id); r.nightAction(m2, ps[9].id); r.nightAction(m3, ps[9].id);
  r.endNight();
  assert.ok(ps[9].alive, 'second doctor save ignored');
  r.endDay();
  throws(() => r.nightAction(d2, ps[9].id), /two nights/);
  r.nightAction(d1, ps[9].id);
  const single = game('MPDVVV');
  throws(() => single.r.chat(single.ps[2], 'doctor', 'hi'), /cannot post/);
});
t('two tabs: closing one keeps the player online', () => {
  const { r } = room();
  const a = r.join('token-aaaaaaaa', 'A').player;
  r.connect(a); r.connect(a); r.disconnect(a);
  assert.strictEqual(a.sockets, 1);
});
t('kick: host only; mid-game kick = out with Mafia/not reveal', () => {
  const { r, ps } = game('MPDVVV');
  throws(() => r.handle(ps[1], 'kick', { id: ps[2].id }), /host/);
  r.handle(ps[0], 'kick', { id: ps[3].id });
  assert.ok(!ps[3].alive && ps[3].left);
  assert.match(r.messages.at(-1).text, /removed by the host\. They were NOT Mafia/);
});
t('back to lobby clears left/offline players and resets roles', () => {
  const { r, ps } = game('MPDVVV');
  r.remove(ps[5], 'left the game'); r.disconnect(ps[4]);
  r.handle(ps[0], 'lobby');
  assert.strictEqual(r.phase, 'lobby');
  assert.strictEqual(r.players.size, 4);
  assert.ok([...r.players.values()].every(p => p.alive && !p.role && !p.spectator));
});
t('play again straight from game over', () => {
  const { r, ps } = game('MPDVVV');
  r.remove(ps[0], 'left the game');
  r.handle(ps[1], 'start');
  assert.strictEqual(r.phase, 'night'); assert.strictEqual(r.round, 1);
  assert.strictEqual([...r.players.values()].filter(p => p.role).length, 5);
});

t('left mid-game: can come back to the same room as a watcher, not alive', () => {
  const { r, ps } = game('MMPDVVVVV');
  r.handle(ps[5], 'leave');
  const back = r.join('token-player-5', 'P5').player;
  assert.strictEqual(back, ps[5]);
  assert.ok(!back.alive && !back.left);
  throws(() => r.vote(back, ps[0].id), /day|Dead/);
  r.chat(back, 'dead', 'I am back');
  throws(() => r.chat(back, 'public', 'hi'), /out|dead|asleep/);
  assert.match(r.join('token-strangerx', 'New').error, /locked/);
});
t('left in lobby: can join the same room again as a fresh player', () => {
  const { r } = room();
  const a = r.join('token-aaaaaaaa', 'A').player; r.connect(a);
  r.handle(a, 'leave');
  const again = r.join('token-aaaaaaaa', 'A').player;
  assert.ok(again && again !== a && r.players.has(again.id));
});

console.log(`all ${passed} rule checks passed`);
