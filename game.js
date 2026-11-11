'use strict';
// All game rules live here. The server only wires sockets to Room.handle().
const crypto = require('crypto');

const MIN_PLAYERS = 4;
const REACTIONS = ['👍', '😂', '😮', '🤔', '😡', '🔪', '👀', '❤️'];
const COLORS = ['#ff6b6b', '#4dabf7', '#51cf66', '#fcc419', '#cc5de8', '#ff922b', '#22b8cf', '#f06595',
  '#94d82d', '#845ef7', '#20c997', '#ffa8a8', '#74c0fc', '#ffd43b', '#e599f7', '#63e6be'];

// 1 mafia per 4 players | police: 5+ → 1, 10+ → 2 | doctor: 6+ → 1, 14+ → 2 | rest villagers.
function roleCounts(n) {
  const mafia = Math.max(1, Math.floor(n / 4));
  const police = n >= 10 ? 2 : n >= 5 ? 1 : 0;
  const doctor = n >= 14 ? 2 : n >= 6 ? 1 : 0;
  return { mafia, police, doctor, villager: Math.max(0, n - mafia - police - doctor) };
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// Returns ids with the highest vote count (ties => several ids) plus that count.
function topVoted(votes, ignore) {
  const counts = new Map();
  for (const t of votes.values()) if (t !== ignore) counts.set(t, (counts.get(t) || 0) + 1);
  let best = 0, top = [];
  for (const [t, c] of counts) { if (c > best) { best = c; top = [t]; } else if (c === best) top.push(t); }
  return { top, count: best };
}

// Deaths only reveal Mafia / not Mafia — Doctor and Police stay secret.
const side = p => p.role === 'mafia' ? 'They WERE Mafia 🔪' : 'They were NOT Mafia';
const TEAMS = ['mafia', 'police', 'doctor']; // private team chat: mafia always, police/doctor only when there are 2

class Room {
  constructor(code, send, schedule = setTimeout, cancel = clearTimeout) {
    Object.assign(this, { code, send, schedule, cancel });
    this.players = new Map();   // id -> player
    this.byToken = new Map();   // secret browser token -> player
    this.hostId = null;
    this.phase = 'lobby';       // lobby | night | day | ended
    this.round = 0;
    this.deadline = 0;
    this.settings = { dayMinutes: 5, nightSeconds: 60 };
    this.messages = [];
    this.msgSeq = 1;
    this.colorSeq = 0;
    this.timer = null;
    this.winner = null;
    this.counts = null;
    this.night = null;
    this.votes = new Map();
    this.emptySince = Date.now();
  }

  // ---------- membership ----------
  join(token, rawName) {
    const known = this.byToken.get(token);
    if (known) return { player: known };
    if (this.phase === 'night' || this.phase === 'day') return { error: 'This game has already started — the room is locked. Ask the host to let you in next game.' };
    if (typeof token !== 'string' || token.length < 10 || token.length > 100) return { error: 'Bad session, refresh the page.' };
    const name = String(rawName || '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
    if (!name) return { error: 'Enter a name.' };
    for (const q of this.players.values())
      if (q.name.toLowerCase() === name.toLowerCase()) return { error: `"${name}" is taken in this room — pick another.` };
    const p = {
      id: crypto.randomBytes(6).toString('hex'), token, name,
      color: COLORS[this.colorSeq++ % COLORS.length],
      sockets: 0, alive: true, role: null, left: false,
      spectator: false,
      lastMsgAt: 0, lastSave: null, results: [],
    };
    this.players.set(p.id, p);
    this.byToken.set(token, p);
    if (!this.hostId) this.hostId = p.id;
    this.sys(`${p.name} joined.`);
    this.broadcast();
    return { player: p };
  }

  connect(p) { p.sockets++; if (!this.host()) this.hostId = p.id; this.broadcast(); }

  disconnect(p) {
    p.sockets = Math.max(0, p.sockets - 1);
    if (![...this.players.values()].some(q => q.sockets)) this.emptySince = Date.now();
    this.broadcast();
  }

  host() { return this.players.get(this.hostId); }
  inGame(p) { return p.role !== null && !p.spectator; }
  ghost(p) { return p.spectator || !p.alive; } // dead or watching

  // Leaving/kick: in lobby the player is removed, mid-game they forfeit (die, role revealed).
  remove(p, reason) {
    this.byToken.delete(p.token);
    this.send(p.id, 'kicked', reason);
    const forfeit = (this.phase === 'night' || this.phase === 'day') && this.inGame(p) && p.alive;
    if (forfeit) p.left = true; else this.players.delete(p.id);
    if (p.id === this.hostId) {
      const next = [...this.players.values()].find(q => q.sockets && !q.left) || [...this.players.values()].find(q => !q.left);
      this.hostId = next ? next.id : null;
    }
    if (!forfeit) { this.sys(`${p.name} ${reason}.`); return this.broadcast(); }
    this.kill(p, `${p.name} ${reason}. ${side(p)}.`);
    if (this.checkWin()) return;
    this.maybeFinishEarly();
    this.broadcast();
  }

  // ---------- game flow ----------
  start() {
    if (this.phase !== 'lobby' && this.phase !== 'ended') throw 'Game already running.';
    if (this.phase === 'ended') this.resetToLobby(false);
    const active = [...this.players.values()].filter(p => p.sockets && !p.left);
    if (active.length < MIN_PLAYERS) throw `Need at least ${MIN_PLAYERS} online players (have ${active.length}).`;
    this.counts = roleCounts(active.length);
    const deck = shuffle([
      ...Array(this.counts.mafia).fill('mafia'), ...Array(this.counts.police).fill('police'),
      ...Array(this.counts.doctor).fill('doctor'), ...Array(this.counts.villager).fill('villager')]);
    for (const p of this.players.values()) {
      Object.assign(p, { alive: true, role: null, spectator: true, lastSave: null, results: [] });
    }
    active.forEach((p, i) => Object.assign(p, { role: deck[i], spectator: false }));
    this.winner = null;
    this.round = 0;
    this.messages = this.messages.filter(m => m.ch === 'public'); // old mafia/graveyard chats stay secret
    this.sys(`🎲 New game with ${active.length} players: ${this.countsText()}.`);
    for (const p of active) this.send(p.id, 'announce', { kind: 'role', role: p.role });
    this.sendHistoryAll();
    this.startNight();
  }

  startNight() {
    this.phase = 'night';
    this.round++;
    this.night = { mafia: new Map(), doctor: new Map(), police: new Map() };
    this.setTimer(this.settings.nightSeconds * 1000, () => this.endNight());
    this.sys(`🌙 Night ${this.round}. The town sleeps. Mafia choose a victim, Doctor protects someone, Police investigates.`);
    this.broadcast();
  }

  nightAction(p, targetId) {
    if (this.phase !== 'night') throw 'You can only act at night.';
    if (!this.inGame(p) || !p.alive) throw 'Dead players cannot act.';
    const t = targetId == null ? null : this.players.get(targetId);
    if (targetId != null && (!t || !this.inGame(t) || !t.alive)) throw 'Pick a living player.';
    if (p.role === 'mafia') {
      if (t && t.role === 'mafia') throw 'You cannot kill a fellow Mafia member.';
      t ? this.night.mafia.set(p.id, t.id) : this.night.mafia.delete(p.id);
    } else if (p.role === 'doctor') {
      if (t && t.id === p.lastSave) throw 'You cannot save the same person two nights in a row.';
      t ? this.night.doctor.set(p.id, t.id) : this.night.doctor.delete(p.id);
    } else if (p.role === 'police') {
      if (t && t.id === p.id) throw 'You already know your own role.';
      if (t && t.id !== p.id && t.role === 'police') throw 'That is your police partner.';
      t ? this.night.police.set(p.id, t.id) : this.night.police.delete(p.id);
    } else throw 'Villagers sleep at night.';
    this.maybeFinishEarly();
    this.broadcast();
  }

  nightDone() {
    const alive = [...this.players.values()].filter(p => this.inGame(p) && p.alive);
    return alive.every(p =>
      p.role === 'villager' ||
      (p.role === 'mafia' && this.night.mafia.has(p.id)) ||
      (p.role === 'doctor' && this.night.doctor.has(p.id)) ||
      (p.role === 'police' && this.night.police.has(p.id)));
  }

  // Night ends 3s after everyone acted; day ends 15s after everyone voted (time to change your mind).
  maybeFinishEarly() {
    if (this.phase === 'night' && this.nightDone() && this.deadline - Date.now() > 3000)
      this.setTimer(3000, () => this.endNight());
    if (this.phase === 'day' && this.aliveIds().every(id => this.votes.has(id)) && this.deadline - Date.now() > 15000)
      this.setTimer(15000, () => this.endDay());
  }

  endNight() {
    if (this.phase !== 'night') return;
    const { top } = topVoted(this.night.mafia);
    const victim = top.length ? this.players.get(top[crypto.randomInt(top.length)]) : null; // mafia tie => random pick
    const saved = new Set();
    for (const doc of this.players.values()) if (doc.role === 'doctor' && this.inGame(doc)) {
      doc.lastSave = doc.alive ? this.night.doctor.get(doc.id) || null : null;
      if (doc.lastSave) saved.add(doc.lastSave);
    }
    // Each living officer investigates on their own; results are shared with the whole police team.
    const police = [...this.players.values()].filter(p => p.role === 'police' && this.inGame(p));
    for (const [cop, tid] of this.night.police) {
      if (!this.players.get(cop)?.alive) continue;
      const t = this.players.get(tid);
      const r = { round: this.round, id: t.id, name: t.name, mafia: t.role === 'mafia', by: this.players.get(cop).name };
      for (const q of police) { q.results.push(r); this.send(q.id, 'announce', { kind: 'investigate', ...r }); }
    }
    let text;
    if (victim && victim.alive && !saved.has(victim.id)) {
      text = `☠️ ${victim.name} was killed by the Mafia. ${side(victim)}.`;
      this.kill(victim, text);
    } else {
      text = victim ? '🩺 The Mafia attacked, but the Doctor saved the victim! Nobody died.' : '🌅 A quiet night. Nobody died.';
      this.sys(text);
    }
    this.announceAll({ kind: 'dawn', text, victim: victim && !victim.alive ? this.pub(victim) : null });
    if (this.checkWin()) return;
    this.startDay();
  }

  startDay() {
    this.phase = 'day';
    this.votes = new Map();
    this.setTimer(this.settings.dayMinutes * 60000, () => this.endDay());
    this.sys(`☀️ Day ${this.round}. Discuss and vote — you have ${this.settings.dayMinutes} min. Most votes is out; a tie or "skip" winning means nobody is out.`);
    this.broadcast();
  }

  vote(p, targetId) {
    if (this.phase !== 'day') throw 'Voting happens during the day.';
    if (!this.inGame(p) || !p.alive) throw 'Dead players cannot vote.';
    if (targetId == null) this.votes.delete(p.id);
    else if (targetId === 'skip') this.votes.set(p.id, 'skip');
    else {
      const t = this.players.get(targetId);
      if (!t || !this.inGame(t) || !t.alive) throw 'Pick a living player.';
      if (t.id === p.id) throw 'You cannot vote for yourself.';
      this.votes.set(p.id, t.id);
    }
    this.maybeFinishEarly();
    this.broadcast();
  }

  endDay() {
    if (this.phase !== 'day') return;
    // Only count votes from players still alive (someone may have left mid-day).
    for (const [v, t] of this.votes) if (!this.players.get(v)?.alive || (t !== 'skip' && !this.players.get(t)?.alive)) this.votes.delete(v);
    const { top, count } = topVoted(this.votes, 'skip');
    const skips = [...this.votes.values()].filter(t => t === 'skip').length;
    let text, out = null;
    if (top.length === 1 && count > skips) {
      out = this.players.get(top[0]);
      text = out.role === 'mafia'
        ? `⚖️ ${out.name} was voted out with ${count} vote(s) — and they WERE Mafia! 🔪`
        : `⚖️ ${out.name} was voted out with ${count} vote(s) — they were NOT Mafia. 😬`;
      this.kill(out, text);
    } else {
      text = !this.votes.size ? '🤷 Nobody voted. Nobody is out.'
        : top.length > 1 ? '⚖️ The vote was tied. Nobody is out.' : '⚖️ The town chose to skip. Nobody is out.';
      this.sys(text);
    }
    this.announceAll({ kind: 'verdict', text, out: out ? this.pub(out) : null, mafia: out?.role === 'mafia' });
    if (this.checkWin()) return;
    this.startNight();
  }

  kill(p, text) {
    p.alive = false;
    this.votes.delete(p.id);
    this.sys(text);
    this.send(p.id, 'announce', { kind: 'dead' });
    this.sendHistory(p); // they can now read the graveyard
  }

  checkWin() {
    const alive = [...this.players.values()].filter(p => this.inGame(p) && p.alive);
    const mafia = alive.filter(p => p.role === 'mafia').length;
    const town = alive.length - mafia;
    if (mafia && mafia < town) return false;
    this.winner = mafia ? 'mafia' : 'town';
    this.phase = 'ended';
    this.cancel(this.timer);
    this.deadline = 0;
    const mafiaNames = [...this.players.values()].filter(p => p.role === 'mafia' && this.inGame(p)).map(p => p.name).join(', ');
    const text = this.winner === 'town' ? '🎉 All Mafia are gone — the TOWN wins!'
      : `🔪 The Mafia now equal or outnumber the town — the MAFIA wins!`;
    this.sys(`${text} Mafia were: ${mafiaNames}.`);
    this.announceAll({ kind: 'gameover', winner: this.winner, text, mafia: mafiaNames });
    this.broadcast();
    return true;
  }

  resetToLobby(announce = true) {
    this.cancel(this.timer);
    for (const p of [...this.players.values()]) {
      if (p.left || !p.sockets) { this.players.delete(p.id); this.byToken.delete(p.token); continue; }
      Object.assign(p, { alive: true, role: null, spectator: false, lastSave: null, results: [] });
    }
    if (!this.players.has(this.hostId)) this.hostId = [...this.players.keys()][0] || null;
    Object.assign(this, { phase: 'lobby', round: 0, deadline: 0, winner: null, counts: null, night: null, votes: new Map() });
    if (announce) { this.sys('↩️ Back in the lobby.'); this.sendHistoryAll(); this.broadcast(); }
  }

  setTimer(ms, fn) {
    this.cancel(this.timer);
    this.deadline = Date.now() + ms;
    this.timer = this.schedule(fn, ms);
  }

  // ---------- chat ----------
  // Team chats (mafia/police) are only ever readable by that team — even after the game ends.
  team(p, ch) { return TEAMS.includes(ch) && p.role === ch && this.inGame(p) && this.counts[ch] > (ch === 'mafia' ? 0 : 1); }

  canRead(p, ch) {
    if (ch === 'public') return true;
    if (this.phase === 'lobby' || this.phase === 'ended') return false;
    if (TEAMS.includes(ch)) return this.team(p, ch);
    if (ch === 'dead') return this.ghost(p);
    return false;
  }

  canWrite(p, ch) {
    if (this.phase === 'lobby' || this.phase === 'ended') return ch === 'public';
    if (ch === 'dead') return this.ghost(p);
    if (!this.inGame(p) || !p.alive) return false;
    if (TEAMS.includes(ch)) return this.team(p, ch);
    return ch === 'public' && this.phase === 'day'; // town sleeps at night
  }

  chat(p, ch, raw) {
    const text = String(raw || '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, 400);
    if (!text) return;
    if (!this.canWrite(p, ch)) throw this.ghost(p) && ch === 'public' ? 'You are out — the dead tell no tales (use the Graveyard chat).'
      : ch === 'public' && this.phase === 'night' ? 'Shh… the town is asleep. Chat opens at day.' : 'You cannot post there.';
    const now = Date.now();
    if (now - p.lastMsgAt < 400) throw 'Slow down a bit!';
    p.lastMsgAt = now;
    this.post({ ch, from: p.id, name: p.name, color: p.color, text });
  }

  sys(text) { this.post({ ch: 'public', from: null, text }); }

  post(m) {
    Object.assign(m, { id: this.msgSeq++, ts: Date.now(), reactions: {} });
    this.messages.push(m);
    if (this.messages.length > 600) this.messages.shift();
    for (const q of this.players.values()) if (this.canRead(q, m.ch)) this.send(q.id, 'msg', m);
  }

  react(p, msgId, emoji) {
    const m = this.messages.find(x => x.id === msgId);
    if (!m || !REACTIONS.includes(emoji) || !m.from) return;
    if (!this.canRead(p, m.ch) || !this.canWrite(p, m.ch)) throw 'You cannot react there right now.';
    const who = m.reactions[emoji] || (m.reactions[emoji] = []);
    const i = who.indexOf(p.id);
    i >= 0 ? who.splice(i, 1) : who.push(p.id);
    if (!who.length) delete m.reactions[emoji];
    for (const q of this.players.values()) if (this.canRead(q, m.ch)) this.send(q.id, 'msgUpdate', { id: m.id, reactions: m.reactions });
  }

  typing(p, ch) {
    if (!this.canWrite(p, ch)) return;
    for (const q of this.players.values()) if (q !== p && this.canRead(q, ch)) this.send(q.id, 'typing', { ch, id: p.id });
  }

  sendHistory(p) { this.send(p.id, 'history', this.messages.filter(m => this.canRead(p, m.ch))); }
  sendHistoryAll() { for (const p of this.players.values()) this.sendHistory(p); }

  // ---------- views ----------
  pub(p) { return { id: p.id, name: p.name, color: p.color }; }
  aliveIds() { return [...this.players.values()].filter(p => this.inGame(p) && p.alive).map(p => p.id); }
  countsText() {
    const c = this.counts;
    return [`${c.mafia} Mafia`, c.police && `${c.police} Police`, c.doctor && `${c.doctor} Doctor${c.doctor > 1 ? 's' : ''}`, `${c.villager} Villager${c.villager === 1 ? '' : 's'}`].filter(Boolean).join(', ');
  }
  announceAll(a) { for (const p of this.players.values()) this.send(p.id, 'announce', a); }
  broadcast() { for (const p of this.players.values()) this.send(p.id, 'state', this.view(p)); }

  view(me) {
    const ended = this.phase === 'ended';
    const eligible = [...this.players.values()].filter(p => p.sockets && !p.left).length;
    return {
      code: this.code, phase: this.phase, round: this.round, deadline: this.deadline, now: Date.now(),
      settings: this.settings, hostId: this.hostId, winner: this.winner, minPlayers: MIN_PLAYERS,
      counts: this.counts || roleCounts(Math.max(eligible, MIN_PLAYERS)), reactions: REACTIONS,
      me: { id: me.id, name: me.name, color: me.color, role: me.role, alive: me.alive, spectator: me.spectator,
        lastSave: me.lastSave, results: me.results,
        canWrite: Object.fromEntries(['public', 'mafia', 'police', 'dead'].map(c => [c, this.canWrite(me, c)])),
        canRead: Object.fromEntries(['public', 'mafia', 'police', 'dead'].map(c => [c, this.canRead(me, c)])) },
      players: [...this.players.values()].map(p => ({
        id: p.id, name: p.name, color: p.color, online: p.sockets > 0, alive: p.alive, spectator: p.spectator, left: p.left,
        inGame: this.inGame(p),
        // You see: your own role, your teammates (mafia/police), dead players as mafia/town only, everything once the game is over.
        role: ended || p === me || (TEAMS.includes(me.role) && this.inGame(me) && p.role === me.role && this.inGame(p)) ? p.role
          : !p.alive && this.inGame(p) ? (p.role === 'mafia' ? 'mafia' : 'town') : null,
      })),
      votes: this.phase === 'day' ? Object.fromEntries(this.votes) : null,
      night: this.phase !== 'night' || !this.inGame(me) || !me.alive ? null
        : me.role === 'mafia' ? { picks: Object.fromEntries(this.night.mafia) }
        : me.role === 'doctor' ? { mine: this.night.doctor.get(me.id), picks: Object.fromEntries(this.night.doctor) }
        : me.role === 'police' ? { mine: this.night.police.get(me.id), picks: Object.fromEntries(this.night.police) } : null,
    };
  }

  // ---------- socket entry point ----------
  handle(p, type, a = {}) {
    const isHost = p.id === this.hostId;
    switch (type) {
      case 'chat': return this.chat(p, a.ch, a.text);
      case 'react': return this.react(p, a.id, a.emoji);
      case 'typing': return this.typing(p, a.ch);
      case 'vote': return this.vote(p, a.target);
      case 'night': return this.nightAction(p, a.target);
      case 'leave': return this.remove(p, 'left the game');
      case 'start': if (!isHost) throw 'Only the host can start.'; return this.start();
      case 'lobby': if (!isHost) throw 'Only the host can do that.'; return this.resetToLobby();
      case 'stop': {
        if (!isHost) throw 'Only the host can stop the game.';
        if (this.phase !== 'night' && this.phase !== 'day') return;
        this.sys(`⏹️ ${p.name} (host) stopped the game.`);
        return this.resetToLobby();
      }
      case 'kick': {
        if (!isHost) throw 'Only the host can remove players.';
        const t = this.players.get(a.id);
        if (!t || t === p) return;
        return this.remove(t, 'was removed by the host');
      }
      case 'settings': {
        if (!isHost || this.phase === 'night' || this.phase === 'day') throw 'Settings can be changed by the host between games.';
        const clamp = (v, lo, hi, d) => Number.isFinite(+v) ? Math.min(hi, Math.max(lo, Math.round(+v))) : d;
        this.settings = { dayMinutes: clamp(a.dayMinutes, 1, 10, 5), nightSeconds: clamp(a.nightSeconds, 20, 120, 60) };
        return this.broadcast();
      }
    }
  }
}

module.exports = { Room, roleCounts, topVoted, MIN_PLAYERS };
