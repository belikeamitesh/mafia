// End-to-end over real sockets: PORT=3999 node server.js & node e2e.js
const assert = require('assert');
const { io } = require('socket.io-client');
const URL = 'http://localhost:' + (process.env.PORT || 3999);
const wait = ms => new Promise(r => setTimeout(r, ms));

const RUN = '-' + Date.now();
function client(token) {
  token += RUN; // unique per run so a reused server doesn't see old players
  const s = io(URL, { forceNew: true, transports: ['websocket'] });
  Object.assign(s, { token, state: null, msgs: [], ann: [], toasts: [] });
  s.on('state', x => (s.state = x));
  s.on('msg', m => s.msgs.push(m));
  s.on('announce', a => s.ann.push(a));
  s.on('toast', t => s.toasts.push(t));
  s.join = a => new Promise(r => s.emit('join', { token, ...a }, r));
  s.act = (type, a = {}) => s.emit('act', { type, ...a });
  return s;
}

(async () => {
  const host = client('e2e-token-host-0001');
  const { code, error } = await host.join({ create: true, name: 'Host' });
  assert.ok(code && !error);
  const others = ['Ann', 'Bob', 'Cat', 'Dan', 'Eve'].map((n, i) => client('e2e-token-p' + i + '-xxxx'));
  for (const [i, c] of others.entries()) assert.ok((await c.join({ code, name: ['Ann', 'Bob', 'Cat', 'Dan', 'Eve'][i] })).ok);
  const all = [host, ...others];

  // same browser in a second tab: still one player
  const tab2 = client('e2e-token-p0-xxxx');
  assert.ok((await tab2.join({ code })).ok);
  await wait(200);
  assert.strictEqual(host.state.players.length, 6);

  // duplicate name from another browser rejected; bad room rejected
  assert.match((await client('e2e-token-dupe-xx').join({ code, name: 'ann' })).error, /taken/);
  assert.match((await client('e2e-token-nope-xx').join({ code: 'ZZZZZ', name: 'X' })).error, /no longer exists/);

  // non-host cannot start
  others[0].act('start'); await wait(150);
  assert.strictEqual(host.state.phase, 'lobby');
  assert.match(others[0].toasts.at(-1), /host/);

  host.act('start'); await wait(300);
  assert.strictEqual(host.state.phase, 'night');
  // each client was told only its own role
  for (const c of all) {
    assert.strictEqual(c.ann.filter(a => a.kind === 'role').length, 1);
    assert.strictEqual(c.ann.find(a => a.kind === 'role').role, c.state.me.role);
    const known = c.state.players.filter(p => p.role && p.id !== c.state.me.id);
    assert.ok(known.every(p => p.role === c.state.me.role && c.state.me.role === 'mafia'), 'saw a role it should not');
  }
  // late joiner locked out
  assert.match((await client('e2e-token-late-xx').join({ code, name: 'Late' })).error, /locked/);

  // mafia chat reaches only mafia
  const mafia = all.find(c => c.state.me.role === 'mafia');
  mafia.act('chat', { ch: 'mafia', text: 'psst' }); await wait(200);
  for (const c of all) assert.strictEqual(c.msgs.some(m => m.text === 'psst'), c.state.me.role === 'mafia');
  // town chat closed at night
  const vill = others.find(c => c.state.me.role !== 'mafia');
  vill.act('chat', { ch: 'public', text: 'hello?' }); await wait(150);
  assert.match(vill.toasts.at(-1), /asleep/);

  // non-host cannot stop, host can
  vill.act('stop'); await wait(150);
  assert.strictEqual(host.state.phase, 'night');
  host.act('stop'); await wait(200);
  for (const c of all) assert.strictEqual(c.state.phase, 'lobby');

  // refresh: reconnect with same token restores the same player
  const id = others[1].state.me.id; others[1].disconnect();
  const again = client('e2e-token-p1-xxxx'); assert.ok((await again.join({ code })).ok); await wait(150);
  assert.strictEqual(again.state.me.id, id);

  // one room per browser: cannot create or join another while in one
  const second = await host.join({ create: true, name: 'Host' });
  assert.ok(second.error && second.code === code, 'host could create a 2nd room');
  const other = client('e2e-token-other-01');
  const otherCode = (await other.join({ create: true, name: 'Owner' })).code;
  const hop = await client('e2e-token-p2-xxxx').join({ code: otherCode, name: 'Cat' });
  assert.strictEqual(hop.code, code, 'player could join a 2nd room');
  // a missing room says so clearly
  assert.ok((await client('e2e-token-gone-xx').join({ code: 'QQQQQ', resume: true })).gone);
  // leaving frees you to create a new room
  others[2].act('leave'); await wait(200);
  const fresh = await others[2].join({ create: true, name: 'Cat' }); // same page: Leave, then Create
  assert.ok(fresh.ok && fresh.code !== code, 'could not create after leaving');

  console.log('e2e passed');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
