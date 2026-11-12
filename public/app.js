'use strict';
// Mafia Night client: renders server state, sends player actions. All rules live on the server (game.js).
const ROLES = {
  villager: { icon: '🧑‍🌾', name: 'Villager', team: 'Town', goal: 'Find and vote out every Mafia member.',
    how: ['At night you sleep — nothing to do.', 'During the day, read the chat, ask questions, spot liars.', 'Vote for who you think is Mafia. Most votes gets eliminated.'] },
  mafia: { icon: '🔪', name: 'Mafia', team: 'Mafia', goal: 'Kill townspeople until Mafia equal or outnumber the town.',
    how: ['At night, pick a victim with your team (use the Mafia chat). Most Mafia votes wins; ties are random.', 'During the day, act innocent. Blend in and vote like a villager.', 'You can see who your teammates are; nobody else can.'] },
  doctor: { icon: '🩺', name: 'Doctor', team: 'Town', goal: 'Keep the town alive and help vote out the Mafia.',
    how: ['Every night, pick one person to protect. If the Mafia attacks them, they survive.', 'In very big games (14+) there are 2 Doctors: you know each other, each protect one person, and share a private Doctors chat.', 'You may protect yourself, but not the same person two nights in a row.', 'During the day, vote like a villager. Revealing you are the Doctor makes you a target!'] },
  police: { icon: '🕵️', name: 'Police', team: 'Town', goal: 'Investigate players and guide the town to the Mafia.',
    how: ['Every night, pick one person to investigate. In the morning you privately learn if they are Mafia or not.', 'In big games (10+) there are 2 Police: you know each other, share results, and have a private Police chat.', 'Use what you learn to steer the vote — but careful, if the Mafia figure out who you are, you are next.', 'During the day, vote like everyone else.'] },
};
// Shown on dead players: only Mafia / not Mafia is ever revealed mid-game.
ROLES.town = { icon: '🏘️', name: 'Not Mafia' };
const PHASE = { lobby: '🏠 Lobby', night: '🌙 Night', day: '☀️ Day', ended: '🏁 Game over' };
const CHANNELS = { public: '🏘️ Town', mafia: '🔪 Mafia', police: '🕵️ Police', doctor: '🩺 Doctors', dead: '👻 Graveyard' };

const $ = s => document.querySelector(s);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); for (const k of kids) if (k != null) e.append(k); return e; };
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

// One secret token per browser: every tab of this browser is the same player.
let token = store.get('mafia_token');
if (!token) { token = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)) + '-' + Math.random().toString(36).slice(2); store.set('mafia_token', token); }
$('#nameIn').value = store.get('mafia_name') || '';

const socket = io();
// Your current room survives refreshes and reopening the site, until you press Leave.
let S = null, roomCode = new URLSearchParams(location.search).get('room')?.toUpperCase() || store.get('mafia_room') || null;
let msgs = new Map(), tab = 'public', unread = { public: 0, mafia: 0, police: 0, doctor: 0, dead: 0 }, clockSkew = 0, mobilePane = 'left';
const typers = {}; let lastTypingSent = 0, rec = null; // rec: the voice note being recorded

// ---------- connection ----------
function join(opts) {
  socket.emit('join', { token, ...opts }, res => {
    if (res.error) {
      // Already in another room: take them back there instead of starting a second game.
      if (res.code) { toast(res.error); roomCode = res.code; return join({ code: res.code, resume: true }); }
      if (opts.resume && res.needName) return showLanding(roomCode);
      toast(res.error);
      if (res.gone) { forgetRoom(); store.set('mafia_last_room', ''); showLanding(); }
      return;
    }
    roomCode = res.code;
    store.set('mafia_room', roomCode); store.set('mafia_last_room', '');
    history.replaceState(null, '', '/?room=' + roomCode);
    $('#landing').classList.add('hidden'); $('#app').classList.remove('hidden');
  });
}
socket.on('connect', () => { if (roomCode) join({ code: roomCode, resume: true }); else showLanding(); });
socket.on('disconnect', () => toast('Connection lost — reconnecting…'));
socket.on('state', s => { clockSkew = s.now - Date.now(); const prev = S; S = s; render(); if (!prev) renderMsgs(); else phaseAlerts(prev, s); });
socket.on('history', list => { msgs = new Map(list.map(m => [m.id, m])); renderMsgs(); });
socket.on('msg', m => {
  msgs.set(m.id, m);
  if (m.from) delete typers[m.ch + m.from];
  if (m.ch === tab) appendMsg(m); else if (m.from) unread[m.ch]++;
  if (S && m.from && m.from !== S.me.id && pingsMe(m)) { const t = `💬 ${m.name} ${m.reply && msgs.get(m.reply.id)?.from === S.me.id ? 'replied to you' : 'mentioned you'}${m.ch !== 'public' ? ' in ' + CHANNELS[m.ch] : ''}`; toast(t); alertMe('ping', t); }
  if (mobilePane !== 'chat' && m.from && m.from !== S?.me.id) unread._m = (unread._m || 0) + 1;
  renderTabs(); renderTyping();
});
socket.on('msgUpdate', u => { const m = msgs.get(u.id); if (m) { m.reactions = u.reactions; const n = document.querySelector(`[data-mid="${u.id}"] .rx`); if (n) n.replaceWith(rxRow(m)); } });
socket.on('typing', t => { typers[t.ch + t.id] = { ...t, until: Date.now() + 3000 }; renderTyping(); });
socket.on('toast', toast);
socket.on('announce', a => announce(a));
function forgetRoom() { stopRec(true); cancelReply(); S = null; roomCode = null; msgs = new Map(); $('#msgs').replaceChildren(); store.set('mafia_room', ''); history.replaceState(null, '', '/'); }
// Render's free plan sleeps after 15 idle minutes; a ping while in a room keeps a running game alive.
setInterval(() => { if (roomCode) fetch('/health').catch(() => {}); }, 4 * 60000);
socket.on('closed', by => { const code = roomCode; forgetRoom(); store.set('mafia_last_room', ''); showLanding(); toast(`${by} (host) stopped the game and closed room ${code}.`); });
socket.on('kicked', reason => { if (/left/.test(reason)) store.set('mafia_last_room', roomCode); forgetRoom(); showLanding(); toast('You ' + reason.replace('was ', 'were ') + '.'); });

function showLanding(code) {
  $('#app').classList.add('hidden'); $('#landing').classList.remove('hidden');
  $('#joinBox').classList.toggle('hidden', !code); $('#createBox').classList.toggle('hidden', !!code);
  $('#joinCode').textContent = code || '';
  const last = store.get('mafia_last_room');
  $('#rejoinBtn').classList.toggle('hidden', !last);
  $('#rejoinBtn').textContent = '↩️ Rejoin room ' + last;
}
$('#rejoinBtn').onclick = () => { const name = named(); if (name) { roomCode = store.get('mafia_last_room'); join({ code: roomCode, name }); } };
const named = () => { const n = $('#nameIn').value.trim(); if (!n) { toast('Enter your name first'); $('#nameIn').focus(); } else store.set('mafia_name', n); return n; };
$('#createBtn').onclick = () => { const name = named(); if (name) join({ create: true, name }); };
$('#joinBtn').onclick = () => { const name = named(); if (name) join({ code: roomCode, name }); };
$('#codeBtn').onclick = () => { const name = named(), code = $('#codeIn').value.trim().toUpperCase(); if (!code) return toast('Enter a room code'); if (name) { roomCode = code; join({ code, name }); } };
$('#nameIn').onkeydown = e => { if (e.key === 'Enter') ($('#joinBox').classList.contains('hidden') ? $('#createBtn') : $('#joinBtn')).click(); };
$('#codeIn').onkeydown = e => { if (e.key === 'Enter') $('#codeBtn').click(); };

const act = (type, a = {}) => socket.emit('act', { type, ...a });

// ---------- render ----------
const P = id => S.players.find(p => p.id === id);
const avatar = (p, cls = '') => el('div', { className: 'av ' + cls, textContent: [...p.name][0].toUpperCase(), style: `background:${p.color}`, title: p.name });

function render() {
  document.body.classList.toggle('night', S.phase === 'night');
  $('#hCode').textContent = S.code;
  const ph = $('#hPhase'); ph.className = 'chip phase ' + S.phase;
  ph.textContent = PHASE[S.phase] + (S.round && S.phase !== 'ended' && S.phase !== 'lobby' ? ' ' + S.round : '');
  const r = S.me.role && ROLES[S.me.role];
  $('#hRole').classList.toggle('hidden', !r);
  if (r) { $('#hRole').replaceChildren(`${r.icon} ${r.name}${S.me.alive ? '' : ' ☠️'} `, el('i', { className: 'info', textContent: 'i' })); $('#hRole').onclick = () => roleInfo(S.me.role); }
  $('#closeBtn').classList.toggle('hidden', S.hostId !== S.me.id);
  renderPhaseCard(); renderPlayers(); renderBanner(); renderTabs(); renderComposer(); tick();
}

function renderPhaseCard() {
  const c = $('#phaseCard'), me = S.me, isHost = S.hostId === me.id, kids = [];
  const alive = me.alive && !me.spectator && me.role;
  const counts = S.counts, chips = el('div', { className: 'roles' },
    ...[['mafia', counts.mafia], ['police', counts.police], ['doctor', counts.doctor], ['villager', counts.villager]].filter(x => x[1])
      .map(([k, n]) => { const ch = el('span', { className: 'chip', style: 'cursor:pointer' }, `${ROLES[k].icon} ${n > 1 ? n + '× ' : ''}${ROLES[k].name} `, el('i', { className: 'info', textContent: 'i' })); ch.onclick = () => roleInfo(k); return ch; }));
  const h = t => el('h2', { textContent: t }), p = t => el('p', { className: 'muted', textContent: t });
  if (S.phase === 'lobby') {
    const n = S.players.filter(x => x.online).length;
    kids.push(h(n < S.minPlayers ? `Waiting for players… ${n}/${S.minPlayers}` : `${n} players ready`),
      p(n < S.minPlayers ? `Share the invite link — need at least ${S.minPlayers} players.` : 'Roles for this many players:'), chips);
    if (isHost) {
      const day = el('input', { type: 'number', min: 1, max: 10, value: S.settings.dayMinutes });
      const night = el('input', { type: 'number', min: 20, max: 120, step: 10, value: S.settings.nightSeconds });
      const save = () => act('settings', { dayMinutes: day.value, nightSeconds: night.value });
      day.onchange = night.onchange = save;
      kids.push(el('div', { className: 'settings' }, el('span', { textContent: '☀️ Day discussion (minutes, max 10)' }), day, el('span', { textContent: '🌙 Night length (seconds)' }), night));
      const b = el('button', { className: 'primary', textContent: '🎲 Start game', disabled: n < S.minPlayers, style: 'width:100%;margin-top:12px' }); b.onclick = () => act('start'); kids.push(b);
    } else kids.push(el('p', { className: 'muted', style: 'margin-top:10px', textContent: `⏳ Waiting for ${P(S.hostId)?.name || 'the host'} 👑 to start. Day: ${S.settings.dayMinutes} min · Night: ${S.settings.nightSeconds}s` }));
  } else if (S.phase === 'ended') {
    const town = S.winner === 'town';
    kids.push(h(town ? '🎉 Town wins!' : '🔪 Mafia wins!'), p('All roles are revealed below.'));
    if (S.recap?.length) kids.push(recapNode(S.recap));
    if (isHost) {
      const again = el('button', { className: 'primary', textContent: '🔁 Play again', style: 'margin-top:12px' }); again.onclick = () => act('start');
      const lob = el('button', { textContent: '↩️ Lobby', style: 'margin:12px 0 0 8px' }); lob.onclick = () => act('lobby');
      kids.push(again, lob);
    } else kids.push(p('Waiting for the host to start another round…'));
  } else if (!alive) {
    kids.push(h(me.spectator ? '👀 Spectating' : '👻 You are out'), p(me.spectator ? 'A game is running. You will be dealt in next game. Chat with other spectators and the dead in the Graveyard.' : 'You cannot talk in Town chat or vote anymore. Watch, and chat with other ghosts in the Graveyard.'), chips);
  } else if (S.phase === 'night') {
    const t = { villager: ['😴 Night — the town sleeps', 'The Mafia is choosing who to eliminate, while the Doctor and Police make their moves. Wait for dawn — Town chat reopens in the morning.'],
      mafia: ['🔪 Choose a victim', 'Agree on a target in the Mafia chat. The player with the most Mafia votes is attacked; a tie is decided at random.'],
      doctor: ['🩺 Protect someone', 'If the Mafia attacks the player you protect, they survive. You can protect yourself, but not the same person two nights in a row.' + (S.counts.doctor > 1 ? ' The other Doctor saves someone too — split up in the Doctors chat.' : '')],
      police: ['🕵️ Investigate someone', S.counts.police > 1 ? 'You and your partner each check one person; both of you see both results at dawn. Plan in the Police chat.' : 'At dawn you will privately learn if they are Mafia. Nobody else sees the result.'] }[me.role];
    kids.push(h(t[0]), p(t[1]));
    taskHint(kids);
  } else if (S.phase === 'day') {
    const skips = Object.values(S.votes).filter(v => v === 'skip').length, mine = S.votes[me.id];
    const voted = Object.keys(S.votes).length, total = S.players.filter(x => x.inGame && x.alive).length;
    kids.push(h('🗳️ Discuss & vote'), p(`Votes are public and you can change yours until time runs out. Most votes is out. ${voted}/${total} voted.`));
    taskHint(kids);
    const sk = el('button', { className: mine === 'skip' ? 'primary' : 'ghost', textContent: `⏭️ Skip vote (${skips})`, style: 'margin-top:10px' });
    sk.onclick = () => act('vote', { target: mine === 'skip' ? null : 'skip' }); kids.push(sk);
  }
  if (me.role === 'police' && me.results.length)
    kids.push(el('div', { className: 'results' }, el('b', { textContent: S.counts.police > 1 ? '🕵️ Police results (only the police team sees this)' : '🕵️ Your investigations (only you see this)' }),
      ...me.results.map(r => el('div', {}, `Night ${r.round}: ${r.name}${S.counts.police > 1 ? ' (by ' + r.by + ')' : ''} → `, el('span', { className: 'tag ' + (r.mafia ? 'mafia' : 'ok'), textContent: r.mafia ? '🔪 MAFIA' : '✔ Not Mafia' })))));
  if (alive && me.role !== 'villager') {
    const mates = S.players.filter(x => x.role === me.role && x.id !== me.id).map(x => x.name);
    if (mates.length) kids.push(p(`Your team: ${mates.join(', ')}`));
  }
  c.replaceChildren(...kids);
}

function renderPlayers() {
  const me = S.me, alive = me.alive && !me.spectator && me.role, isHost = S.hostId === me.id;
  const tally = {}; if (S.votes) for (const t of Object.values(S.votes)) tally[t] = (tally[t] || 0) + 1;
  const picks = S.night?.picks || {}, checked = Object.fromEntries((me.results || []).map(r => [r.id, r.mafia]));
  const order = p => p.left ? 4 : p.spectator ? 3 : !p.alive ? 2 : 0;
  const list = [...S.players].filter(p => !p.left || p.role).sort((a, b) => order(a) - order(b));
  $('#players').replaceChildren(...list.map(p => {
    const isMe = p.id === me.id, tags = [];
    if (isMe) tags.push(el('span', { className: 'tag', textContent: 'You' }));
    if (p.id === S.hostId) tags.push(el('span', { className: 'tag', textContent: '👑 Host' }));
    if (p.role && !isMe) tags.push(el('span', { className: 'tag' + (p.role === 'mafia' ? ' mafia' : ''), textContent: ROLES[p.role].icon + ' ' + ROLES[p.role].name }));
    if (!p.alive && p.inGame) tags.push(el('span', { className: 'tag', textContent: p.left ? '🚪 left' : '☠️ out' }));
    if (p.spectator && S.phase !== 'lobby') tags.push(el('span', { className: 'tag', textContent: '👀 watching' }));
    if (p.id in checked) tags.push(el('span', { className: 'tag ' + (checked[p.id] ? 'mafia' : 'ok'), textContent: checked[p.id] ? '🕵️ Mafia!' : '🕵️ clean' }));
    if (!p.online && !p.left) tags.push(el('span', { className: 'tag', textContent: 'offline' }));
    const av = avatar(p); av.append(el('span', { className: 'dot' + (p.online ? '' : ' off') }));
    const meta = el('div', { className: 'meta' }, el('div', { className: 'nm', textContent: p.name, style: `color:${p.color}` }), el('div', { className: 'sub' }, ...tags));
    const card = el('div', { className: 'pl' + (isMe ? ' me' : '') + (!p.alive || p.spectator && S.phase !== 'lobby' ? ' dead' : '') }, av, meta);
    // Who's pointing at this player (day votes / mafia night picks)
    const pointers = S.phase === 'day' ? Object.entries(S.votes).filter(([, t]) => t === p.id).map(([v]) => v)
      : Object.entries(picks).filter(([, t]) => t === p.id).map(([v]) => v);
    if (pointers.length) meta.append(el('div', { className: 'voters' }, ...pointers.map(v => P(v) && avatar(P(v), 'sm'))));
    if (S.phase === 'day' && tally[p.id]) card.append(el('div', { className: 'votes', textContent: tally[p.id] }));
    const target = p.inGame && p.alive;
    let mine = null, can = false;
    if (alive && target && S.phase === 'day' && !isMe) { mine = S.votes[me.id]; can = true; }
    if (alive && target && S.phase === 'night') {
      if (me.role === 'mafia' && p.role !== 'mafia') { mine = picks[me.id]; can = true; }
      if (me.role === 'doctor' && p.id !== me.lastSave) { mine = S.night?.mine; can = true; }
      if (me.role === 'police' && p.role !== 'police') { mine = S.night?.mine; can = true; }
    }
    if (me.role === 'doctor' && S.phase === 'night' && p.id === me.lastSave && alive) meta.querySelector('.sub').append(el('span', { className: 'tag', textContent: 'saved last night' }));
    if (can) {
      card.classList.add('clickable'); if (mine === p.id) card.classList.add('target');
      const task = myTask();
      if (task && !task.choice) { card.classList.add('pickme'); meta.querySelector('.sub').append(el('span', { className: 'act-label', textContent: task.label })); }
      card.title = { day: 'Vote out', night: { mafia: 'Kill', doctor: 'Save', police: 'Investigate' }[me.role] }[S.phase] + ' ' + p.name;
      card.onclick = () => act(S.phase === 'day' ? 'vote' : 'night', { target: mine === p.id ? null : p.id });
    }
    if (isHost && !isMe && (S.phase === 'lobby' || S.phase === 'ended')) {
      const k = el('button', { className: 'kick', textContent: '✕', title: S.phase === 'lobby' ? 'Remove' : 'Remove (counts as leaving — they are out)' });
      k.onclick = e => { e.stopPropagation(); if (confirm(`Remove ${p.name}?` + (S.phase === 'day' || S.phase === 'night' ? ' They will be out of this game and their role revealed.' : ''))) act('kick', { id: p.id }); };
      card.append(k);
    }
    return card;
  }));
}

// ---------- guidance: what should I do right now? ----------
// Drives the 👇 hint in the phase card, the glowing player cards and the banner above the chat box.
function myTask() {
  const me = S.me;
  if (!me.role || me.spectator || !me.alive) return null;
  const nm = id => P(id)?.name;
  if (S.phase === 'day') {
    const v = S.votes[me.id];
    return {
      label: '🗳️ Vote out', choice: v,
      todo: me.role === 'mafia' ? '👇 Blend in: tap a player below to vote them out — just not your own teammate.' : '👇 Tap the player you think is Mafia to vote them out.',
      done: v === 'skip' ? '✅ You voted to skip. Tap a player if you change your mind.' : `✅ You voted to eliminate ${nm(v)}. Tap them again to take it back, or tap someone else.`,
      banner: '🗳️ Time to vote — tap here to choose who goes',
    };
  }
  if (S.phase !== 'night' || !S.night) return null;
  const pick = S.night.mine ?? S.night.picks?.[me.id];
  const t = {
    mafia: ['🔪 Choose', '👇 Tap a player below to choose tonight\'s victim.', n => `✅ You chose ${n}. Your team can see your pick — tap another player to change it.`, '🔪 Your move — tap here to choose a victim'],
    doctor: ['🩺 Protect', '👇 Tap a player below to protect them tonight.', n => `✅ You are protecting ${n} tonight. Tap another player to change.`, '🩺 Your move — tap here to protect someone'],
    police: ['🕵️ Check', '👇 Tap a player below to investigate them.', n => `✅ At dawn you will learn if ${n} is Mafia. Tap another player to change.`, '🕵️ Your move — tap here to investigate someone'],
  }[me.role];
  return t && { label: t[0], choice: pick, todo: t[1], done: pick && t[2](nm(pick)), banner: t[3] };
}
function taskHint(kids) {
  const t = myTask();
  if (t) kids.push(el('div', { className: 'hint' + (t.choice ? ' done' : ''), textContent: t.choice ? t.done : t.todo }));
}
function renderBanner() {
  const b = $('#actionBanner'), t = myTask(), ghost = !S.me.alive || S.me.spectator;
  b.className = 'actbanner hidden'; b.onclick = null;
  if (t && !t.choice) {
    b.className = 'actbanner todo'; b.textContent = t.banner;
    b.onclick = () => {
      if (mobilePane !== 'left') document.querySelector('.mnav button[data-pane=left]').click();
      const grid = $('#players'); grid.scrollIntoView({ block: 'nearest' }); grid.classList.remove('flash'); void grid.offsetWidth; grid.classList.add('flash');
    };
  } else if (S.phase === 'night' && tab === 'public' && S.me.role) {
    b.className = 'actbanner info';
    b.textContent = ghost ? '🌙 Night — the Mafia is choosing a victim. Chat with other ghosts in the Graveyard.'
      : t ? '🌙 Your choice is locked in. Waiting for the night to end…' : '🌙 The town sleeps… the Mafia is choosing a victim. Chat reopens at dawn.';
  }
}

// ---------- chat ----------
function renderTabs() {
  if (!S) return;
  const chans = Object.keys(CHANNELS).filter(c => S.me.canRead[c]);
  if (!chans.includes(tab)) { tab = 'public'; renderMsgs(); }
  $('#tabs').replaceChildren(...chans.map(c => {
    const b = el('button', { className: c === tab ? 'on' : '', textContent: CHANNELS[c] }); b.dataset.ch = c;
    if (unread[c] && c !== tab) b.append(el('span', { className: 'badge', textContent: unread[c] }));
    b.onclick = () => { if (replying && replying.ch !== c) cancelReply(); tab = c; unread[c] = 0; renderTabs(); renderMsgs(); renderComposer(); renderTyping(); renderBanner(); };
    return b;
  }));
  $('#tabs').classList.toggle('hidden', chans.length < 2);
  $('#mBadge').replaceChildren(unread._m ? el('span', { className: 'badge', textContent: unread._m }) : '');
}

function renderComposer() {
  const can = S.me.canWrite[tab], i = $('#msgIn');
  i.disabled = $('#sendBtn').disabled = !can;
  $('#micBtn').disabled = !can && !rec;
  $('#emojiBtn').disabled = !can;
  if (!can) $('#emojiPanel').classList.add('hidden');
  i.placeholder = can ? (tab === 'mafia' ? 'Whisper to your Mafia team…' : tab === 'police' ? 'Talk to your police partner…' : tab === 'doctor' ? 'Talk to your fellow doctor…' : tab === 'dead' ? 'Talk to the other ghosts…' : 'Say something… (@name to mention)')
    : !S.me.alive || S.me.spectator ? '👻 You are out — use the Graveyard tab' : S.phase === 'night' ? '🌙 The town is asleep. Chat opens at dawn.' : 'You cannot post here';
}

function renderMsgs() {
  const box = $('#msgs'); box.replaceChildren(); lastGrp = null;
  [...msgs.values()].filter(m => m.ch === tab).forEach(appendMsg);
  box.scrollTop = box.scrollHeight;
}

let lastGrp = null;
function appendMsg(m) {
  if (!S) return;
  const box = $('#msgs'), atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  if (!m.from) { box.append(el('div', { className: 'sysm', textContent: m.text })); lastGrp = null; }
  else {
    const mine = m.from === S.me.id;
    let g = lastGrp && lastGrp.from === m.from && m.ts - lastGrp.ts < 120000 ? lastGrp.node : null;
    if (!g) {
      g = el('div', { className: 'grp' + (mine ? ' mine' : '') }, avatar({ name: m.name, color: m.color }),
        el('div', { className: 'body' }, el('div', { className: 'who', style: `color:${m.color}` }, mine ? 'You' : nameLink(m.name), el('time', { textContent: new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }))));
      box.append(g);
    }
    lastGrp = { from: m.from, ts: m.ts, node: g };
    const bub = el('div', { className: 'bub', style: `--c:${m.color}` }, ...(m.voice ? voiceNode(m.voice) : linkMentions(m.text)));
    if (m.reply) {
      const q = quoteNode(m.reply);
      q.onclick = e => { e.stopPropagation(); jumpTo(m.reply.id); };
      bub.prepend(q);
    }
    if (!mine && pingsMe(m)) bub.classList.add('ping');
    const wrap = el('div', { className: 'bubwrap' }, bub, rxRow(m));
    wrap.dataset.mid = m.id;
    const picker = el('div', { className: 'picker' }, ...S.reactions.map(e => { const b = el('button', { type: 'button', textContent: e }); b.onclick = ev => { ev.stopPropagation(); wrap.classList.remove('open'); act('react', { id: m.id, emoji: e }); }; return b; }));
    const rb = el('button', { type: 'button', textContent: '↩️', title: 'Reply' });
    rb.onclick = ev => { ev.stopPropagation(); wrap.classList.remove('open'); startReply(m); };
    picker.append(rb);
    wrap.prepend(picker);
    bub.onclick = e => { if (e.target.closest('audio')) return; document.querySelectorAll('.bubwrap.open').forEach(x => x !== wrap && x.classList.remove('open')); wrap.classList.toggle('open'); };
    g.querySelector('.body').append(wrap);
  }
  if (atBottom || m.from === S.me.id) box.scrollTop = box.scrollHeight;
}

function rxRow(m) {
  return el('div', { className: 'rx' }, ...Object.entries(m.reactions || {}).map(([e, who]) => {
    const b = el('button', { type: 'button', className: who.includes(S.me.id) ? 'mine' : '', textContent: `${e} ${who.length}`, title: who.map(id => P(id)?.name || '?').join(', ') });
    b.onclick = () => act('react', { id: m.id, emoji: e }); return b;
  }));
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function linkMentions(text) {
  const names = S.players.map(p => p.name).sort((a, b) => b.length - a.length).map(escapeRe);
  if (!names.length) return [text];
  const re = new RegExp('(@(?:' + names.join('|') + '))', 'gi');
  return text.split(re).map((part, i) => i % 2 ? el('span', { className: 'mention', textContent: part }) : part);
}

function renderTyping() {
  const now = Date.now(), list = Object.values(typers).filter(t => t.ch === tab && t.until > now && P(t.id));
  const doing = list.every(t => t.rec) ? 'recording a voice note 🎤…' : 'typing…';
  $('#typing').replaceChildren(...(list.length ? [...list.flatMap((t, i) => [i ? ', ' : '', el('b', { textContent: P(t.id).name + (t.rec ? ' 🎤' : ''), style: `color:${P(t.id).color}` })]), (list.length > 1 ? ' are ' : ' is ') + doing] : []));
}

function voiceNode(v) {
  if (!v.data) return [el('span', { className: 'muted', textContent: `🎤 Voice note (${v.dur}s) — expired` })];
  const src = URL.createObjectURL(new Blob([v.data], { type: v.mime }));
  return [el('div', { className: 'voice' }, '🎤', el('audio', { controls: true, preload: 'metadata', src }), el('span', { className: 'muted', textContent: v.dur + 's' }))];
}

// ---------- voice notes: tap 🎤 to record, tap ⏹ to send, ✕ to discard ----------
async function startRec() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return toast('Voice notes are not supported in this browser.');
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { return toast('Microphone blocked — allow mic access for this site to send voice notes.'); }
  const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find(t => MediaRecorder.isTypeSupported(t));
  const mr = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 32000 } : undefined);
  const r = rec = { mr, chunks: [], start: Date.now(), ch: tab, cancelled: false, replyTo: replying?.id };
  mr.ondataavailable = e => { if (e.data.size) r.chunks.push(e.data); };
  mr.onstop = async () => {
    stream.getTracks().forEach(t => t.stop());
    clearInterval(r.timer); rec = null; showRec(false);
    if (r.cancelled) return;
    const dur = (Date.now() - r.start) / 1000;
    if (dur < 0.8) return toast('Too short — tap 🎤, talk, then tap ⏹ to send.');
    const blob = new Blob(r.chunks, { type: mr.mimeType });
    act('voice', { ch: r.ch, audio: await blob.arrayBuffer(), mime: mr.mimeType, dur, replyTo: r.replyTo }); cancelReply();
  };
  mr.start(); showRec(true);
  r.timer = setInterval(() => {
    const s = Math.floor((Date.now() - r.start) / 1000);
    $('#recTime').textContent = '0:' + String(s).padStart(2, '0');
    if (Date.now() - lastTypingSent > 1500) { lastTypingSent = Date.now(); act('typing', { ch: r.ch, rec: true }); }
    if (s >= 30) stopRec(false);
  }, 250);
}
function stopRec(cancel) { if (rec && rec.mr.state === 'recording') { rec.cancelled = cancel; rec.mr.stop(); } }
function showRec(on) {
  $('#msgIn').classList.toggle('hidden', on); $('#recBar').classList.toggle('hidden', !on);
  $('#micBtn').classList.toggle('on', on); $('#micBtn').textContent = on ? '⏹' : '🎤';
  $('#recTime').textContent = '0:00';
  if (S) renderComposer();
}
$('#micBtn').onclick = () => rec ? stopRec(false) : startRec();
$('#recCancel').onclick = () => stopRec(true);

$('#composer').onsubmit = e => { e.preventDefault(); const t = $('#msgIn').value.trim(); if (!t) return; act('chat', { ch: tab, text: t, replyTo: replying?.id }); $('#msgIn').value = ''; cancelReply(); closeMentions(); $('#emojiPanel').classList.add('hidden'); $('#msgIn').focus(); };
$('#msgIn').onkeydown = e => { if (mentionKey(e)) return; if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#composer').requestSubmit(); } else if (e.key === 'Escape') cancelReply(); };
$('#msgIn').oninput = () => { updateMentions(); if (Date.now() - lastTypingSent > 1500) { lastTypingSent = Date.now(); act('typing', { ch: tab }); } };

// ---------- replies ----------
let replying = null;
const quoteNode = q => el('div', { className: 'quote', style: `--qc:${q.color}` }, el('b', { textContent: q.name }), el('span', { textContent: q.text }));
function startReply(m) {
  replying = { id: m.id, ch: m.ch };
  $('#replyQuote').replaceWith(Object.assign(quoteNode({ name: '↩️ ' + (m.from === S.me.id ? 'You' : m.name), color: m.color, text: m.voice ? `🎤 Voice note (${m.voice.dur}s)` : m.text }), { id: 'replyQuote' }));
  $('#replyBar').classList.remove('hidden');
  if (mobilePane !== 'chat') document.querySelector('.mnav button[data-pane=chat]').click();
  $('#msgIn').focus();
}
function cancelReply() { replying = null; $('#replyBar').classList.add('hidden'); }
$('#replyCancel').onclick = cancelReply;
function jumpTo(id) {
  const n = document.querySelector(`[data-mid="${id}"]`);
  if (!n) return toast('That message is no longer in the chat.');
  n.scrollIntoView({ block: 'center' }); n.classList.remove('flash'); void n.offsetWidth; n.classList.add('flash');
}
// A message pings you if it @mentions you or replies to something you said.
const pingsMe = m => new RegExp('@' + escapeRe(S.me.name) + '(?![\\w])', 'i').test(m.text || '') || msgs.get(m.reply?.id)?.from === S.me.id;

// ---------- @mentions: type @ for a list, or tap a name in the chat ----------
let mentionMatches = [], mentionSel = 0;
function nameLink(name) {
  const s = el('span', { className: 'nmlink', textContent: name, title: 'Mention ' + name });
  s.onclick = () => { if (!S.me.canWrite[tab]) return; insertMention(name, true); };
  return s;
}
function mentionQuery() {
  const i = $('#msgIn'), before = i.value.slice(0, i.selectionStart), m = before.match(/(^|\s)@([^@\n]{0,16})$/);
  return m ? { q: m[2].toLowerCase(), at: before.length - m[2].length - 1 } : null;
}
function updateMentions() {
  const mq = mentionQuery();
  mentionMatches = mq ? S.players.filter(p => p.id !== S.me.id && !p.left && p.name.toLowerCase().startsWith(mq.q)).slice(0, 8) : [];
  mentionSel = 0; drawMentions();
}
function drawMentions() {
  $('#mentionList').classList.toggle('hidden', !mentionMatches.length);
  $('#mentionList').replaceChildren(...mentionMatches.map((p, i) => {
    const b = el('button', { type: 'button', className: i === mentionSel ? 'on' : '' }, avatar(p, 'sm'), el('b', { textContent: p.name, style: `color:${p.color}` }), el('span', { className: 'muted', textContent: p.inGame && !p.alive ? '☠️ out' : '' }));
    b.onmousedown = e => { e.preventDefault(); insertMention(p.name); };
    return b;
  }));
}
function closeMentions() { mentionMatches = []; drawMentions(); }
function insertMention(name, append) {
  const i = $('#msgIn'), mq = !append && mentionQuery();
  const start = mq ? mq.at : i.value.length, end = mq ? i.selectionStart : i.value.length;
  const pre = i.value.slice(0, start), lead = pre && !/\s$/.test(pre) ? ' ' : '';
  i.value = pre + lead + '@' + name + ' ' + i.value.slice(end);
  const pos = (pre + lead + '@' + name + ' ').length;
  i.focus(); i.setSelectionRange(pos, pos); closeMentions();
}
function mentionKey(e) {
  if (!mentionMatches.length) return false;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { mentionSel = (mentionSel + (e.key === 'ArrowDown' ? 1 : -1) + mentionMatches.length) % mentionMatches.length; drawMentions(); }
  else if (e.key === 'Enter' || e.key === 'Tab') insertMention(mentionMatches[mentionSel].name);
  else if (e.key === 'Escape') closeMentions();
  else return false;
  e.preventDefault(); return true;
}
$('#msgIn').onblur = () => setTimeout(closeMentions, 150);

// ---------- emoji picker: the full set with categories, search and skin tones (emoji-picker-element) ----------
// Inserts where the cursor was when the picker opened, and stays open for several picks.
let emojiAt = 0;
$('#emojiBtn').onclick = () => {
  const panel = $('#emojiPanel'), i = $('#msgIn');
  emojiAt = i.selectionStart ?? i.value.length;
  panel.classList.toggle('hidden');
  if (panel.classList.contains('hidden')) i.focus();
};
$('#emojiPicker').addEventListener('emoji-click', e => {
  const i = $('#msgIn'), u = e.detail.unicode;
  i.value = i.value.slice(0, emojiAt) + u + i.value.slice(emojiAt);
  emojiAt += u.length;
});
document.querySelectorAll('.mnav button').forEach(b => b.onclick = () => {
  mobilePane = b.dataset.pane; if (mobilePane === 'chat') unread._m = 0;
  document.querySelectorAll('.mnav button').forEach(x => x.classList.toggle('on', x === b));
  document.querySelectorAll('main>section').forEach(s => s.classList.toggle('show', s.id === mobilePane));
  if (S) renderTabs(); if (mobilePane === 'chat') $('#msgs').scrollTop = 1e9;
});

// ---------- timer ----------
function tick() {
  const t = $('#hTimer');
  if (!S || !S.deadline || S.phase === 'lobby' || S.phase === 'ended') return t.classList.add('hidden');
  const left = Math.max(0, Math.round((S.deadline - Date.now() - clockSkew) / 1000));
  t.classList.remove('hidden'); t.classList.toggle('low', left <= 30);
  t.textContent = '⏱ ' + Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
  // One reminder per phase if you still haven't voted / acted when time is nearly up.
  const key = S.phase + S.round, me = S.me, alive = me.alive && !me.spectator && me.role;
  if (alive && hurried !== key) {
    if (S.phase === 'day' && left <= 30 && !(me.id in S.votes)) { hurried = key; alertMe('hurry', '⏳ 30s left to vote!'); }
    if (S.phase === 'night' && left <= 10 && S.night && !S.night.mine && !S.night.picks?.[me.id]) { hurried = key; alertMe('hurry', '⏳ 10s left to pick!'); }
  }
}

// ---------- alerts: sound + vibration + tab title, so players notice when the tab is in the background ----------
let muted = store.get('mafia_muted') === '1', audioCtx = null, hurried = '', titleTimer = null;
const SOUNDS = { night: [[392, .35], [262, .7]], turn: [[660, .14], [880, .14], [1175, .35]], day: [[523, .18], [659, .18], [784, .4]], hurry: [[988, .1], [988, .1], [988, .1]], end: [[784, .2], [523, .2], [392, .5]], ping: [[1047, .12], [1319, .2]] };
function beep(notes) {
  try {
    audioCtx ||= new AudioContext();
    let t = audioCtx.currentTime;
    for (const [freq, dur] of notes) {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(audioCtx.destination); o.start(t); o.stop(t + dur);
      t += dur * 0.9;
    }
  } catch { /* no audio available: vibration and title still work */ }
}
function alertMe(kind, msg) {
  if (!muted) { beep(SOUNDS[kind]); navigator.vibrate?.(kind === 'hurry' ? [90, 60, 90, 60, 90] : [180, 90, 180]); }
  if (document.hidden && msg) { // blink the tab title until they come back
    clearInterval(titleTimer); let on = false;
    titleTimer = setInterval(() => { document.title = (on = !on) ? msg : 'Mafia Night'; }, 1000);
  }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) { clearInterval(titleTimer); document.title = 'Mafia Night'; } });
// Browsers only allow sound after the first tap on the page.
document.addEventListener('pointerdown', () => { try { (audioCtx ||= new AudioContext()).resume(); } catch {} }, { once: true });
function phaseAlerts(prev, s) {
  if (prev.phase === s.phase && prev.round === s.round) return;
  const acts = s.me.alive && !s.me.spectator && ['mafia', 'doctor', 'police'].includes(s.me.role);
  if (s.phase === 'night') acts ? alertMe('turn', '🔪 Your move — pick someone!') : alertMe('night', '🌙 Night falls…');
  else if (s.phase === 'day') alertMe('day', '☀️ Day — discuss & vote!');
  else if (s.phase === 'ended') alertMe('end', '🏁 Game over!');
}
function renderMute() { $('#muteBtn').textContent = muted ? '🔕' : '🔔'; $('#muteBtn').title = muted ? 'Sounds off — tap to turn on' : 'Sounds on — tap to mute'; }
$('#muteBtn').onclick = () => { muted = !muted; store.set('mafia_muted', muted ? '1' : '0'); renderMute(); if (!muted) beep(SOUNDS.ping); };
renderMute();

// ---------- end-of-game recap: night-by-night timeline ----------
function recapNode(recap) {
  const row = (icon, ...parts) => el('div', { className: 'rc-row' }, el('span', { textContent: icon }), el('span', {}, ...parts.flat()));
  const b = t => el('b', { textContent: t });
  const tag = mafia => el('span', { className: 'tag ' + (mafia ? 'mafia' : 'ok'), textContent: mafia ? 'Mafia' : 'not Mafia' });
  return el('details', { className: 'recap', open: true }, el('summary', { textContent: '📜 What happened' }), ...recap.map(e => {
    if (e.left) return el('div', { className: 'rc' }, row('🚪', b(e.left), ' left the game ', tag(e.mafia)));
    if (e.phase === 'night') return el('div', { className: 'rc' }, el('div', { className: 'rc-h', textContent: `🌙 Night ${e.round}` }),
      row('🔪', e.target ? ['Mafia targeted ', b(e.target), e.killed ? ' — killed ☠️' : ' — saved by the Doctor 🩺'] : 'Mafia did not pick anyone'),
      ...e.saves.map(s => row('🩺', b(s.by), ' protected ', b(s.name))),
      ...e.checks.map(c => row('🕵️', b(c.by), ' checked ', b(c.name), ' → ', tag(c.mafia))));
    const votes = Object.entries(e.votes).map(([t, who]) => row('🗳️', b(t === 'skip' ? 'Skip' : t), ` (${who.length}): ${who.join(', ')}`));
    return el('div', { className: 'rc' }, el('div', { className: 'rc-h', textContent: `☀️ Day ${e.round}` }),
      row('⚖️', e.out ? [b(e.out), ' voted out ', tag(e.mafia)] : 'Nobody was voted out'), ...votes);
  }));
}
setInterval(() => { tick(); renderTyping(); }, 500);

// ---------- overlays ----------
const queue = []; let showing = false;
function announce(a) { queue.push(a); if (!showing) nextAnn(); }
function nextAnn() {
  const a = queue.shift(); if (!a) { showing = false; return; }
  showing = true;
  let icon = '📣', title = '', body = [], cls = '', auto = 9000;
  if (a.kind === 'role') { const r = ROLES[a.role]; icon = r.icon; title = 'You are ' + (a.role === 'villager' ? 'a ' : 'the ') + r.name; cls = a.role === 'mafia' ? 'mafia' : 'good'; body = [el('p', { textContent: r.goal }), el('ul', {}, ...r.how.map(x => el('li', { textContent: x }))), el('p', { className: 'muted', textContent: 'Keep it secret! Tap the ⓘ next to your role anytime.' })]; auto = 0; }
  else if (a.kind === 'dawn') { icon = a.victim ? '☠️' : '🌅'; title = 'Morning'; body = [el('p', { textContent: a.text })]; }
  else if (a.kind === 'verdict') { icon = a.out ? (a.mafia ? '🎯' : '😬') : '⚖️'; title = 'The town has spoken'; cls = a.out ? (a.mafia ? 'good' : 'mafia') : ''; body = [el('p', { textContent: a.text })]; }
  else if (a.kind === 'investigate') { icon = a.mafia ? '🚨' : '✅'; title = 'Investigation result'; cls = a.mafia ? 'mafia' : 'good'; body = [el('p', { textContent: `${a.name} is ${a.mafia ? 'MAFIA! 🔪' : 'NOT Mafia.'}` }), el('p', { className: 'muted', textContent: 'Only you can see this. Use it wisely.' })]; }
  else if (a.kind === 'dead') { icon = '👻'; title = 'You are out'; body = [el('p', { textContent: 'You can no longer chat in Town or vote. Watch the game and chat with other ghosts in the Graveyard.' })]; }
  else if (a.kind === 'gameover') { icon = a.winner === 'town' ? '🎉' : '🔪'; title = a.winner === 'town' ? 'Town wins!' : 'Mafia wins!'; cls = a.winner === 'town' ? 'good' : 'mafia'; body = [el('p', { textContent: a.text }), el('p', { className: 'muted', textContent: 'The Mafia were: ' + a.mafia })]; auto = 0; }
  else if (a.kind === 'info') { icon = a.icon; title = a.title; body = a.body; auto = 0; }
  const ok = el('button', { className: 'primary', textContent: 'Got it', style: 'margin-top:14px;min-width:140px' });
  const ov = el('div', { className: 'overlay' }, el('div', { className: 'ann ' + cls }, el('div', { className: 'big', textContent: icon }), el('h2', { textContent: title }), ...body, ok));
  let timer;
  const close = () => { clearTimeout(timer); ov.remove(); nextAnn(); };
  ok.onclick = close; ov.onclick = e => { if (e.target === ov) close(); };
  if (auto) timer = setTimeout(close, auto);
  $('#overlayRoot').append(ov);
}
function roleInfo(k) {
  const r = ROLES[k];
  announce({ kind: 'info', icon: r.icon, title: r.name + ' · Team ' + r.team, body: [el('p', { textContent: r.goal }), el('ul', {}, ...r.how.map(x => el('li', { textContent: x })))] });
}
function showRules() {
  const li = t => el('li', { textContent: t });
  announce({ kind: 'info', icon: '📖', title: 'How to play', body: [el('ul', {},
    li('Everyone secretly gets a role. Mafia know each other; nobody else knows anyone.'),
    li('Roles scale with players: 1 Mafia per 4 players · Police: none under 5, 1 for 5–9, 2 for 10+ · Doctor: none under 6, 1 for 6–13, 2 for 14+. Everyone else is a Villager. Min 4 players, no max.'),
    li('The person who creates the room is the host: they share the link, press Start once everyone is in, and can press ⏹ Stop at any time to end the game, delete the chat and close the room. Once a game starts the room is locked — nobody new can join until it ends.'),
    li('You only know your own role. Mafia know each other and share a private chat. With 2 Police (or 2 Doctors), those two know each other and share a private chat. A single Police or Doctor has no private chat.'),
    li('🌙 Night: Mafia pick a victim, Doctor protects one person, Police checks one person. Town chat is closed.'),
    li('☀️ Day: the victim is revealed, along with whether they were Mafia (never their exact role). Discuss, then vote (max 10 min). Most votes is out, and everyone learns if they were Mafia or not. A tie, or more "skip" votes than the top, means nobody is out.'),
    li('Out players can\'t chat in Town or vote — they talk in the Graveyard.'),
    li('Town wins when every Mafia is out. Mafia wins when they equal or outnumber everyone else.'),
    li('Leaving mid-game counts as being out (only Mafia / not Mafia is revealed).'),
    li('One player per browser — refreshing or opening another tab keeps you as the same player.'))] });
}
function toast(t) { const n = el('div', { className: 'toast', textContent: t }); $('#toasts').append(n); setTimeout(() => n.remove(), 3500); }

$('#shareBtn').onclick = async () => {
  const url = location.origin + '/?room=' + S.code;
  if (navigator.share && matchMedia('(pointer:coarse)').matches) { try { await navigator.share({ title: 'Join my Mafia game', text: 'Join my Mafia game 🔪', url }); return; } catch {} }
  try { await navigator.clipboard.writeText(url); toast('Invite link copied! 🔗'); } catch { prompt('Copy this link:', url); }
};
$('#closeBtn').onclick = () => { if (confirm('Stop for everyone? The game ends, the chat is deleted and this room code stops working.')) act('close'); };
$('#leaveBtn').onclick = () => {
  const mid = S && (S.phase === 'day' || S.phase === 'night') && S.me.alive && !S.me.spectator;
  if (confirm(mid ? 'Leave the game? You will be out and your role revealed.' : 'Leave this room?')) act('leave');
};
