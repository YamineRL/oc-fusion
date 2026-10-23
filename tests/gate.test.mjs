// Behavior tests for strata-gate: a stub llama-swap and a stub opencode
// server, the real gate as a child process. Run: node --test gate.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GATE = 18082, UP = 18092, OC = 18095;
const GRACE_S = 1.5;
const order = [];          // upstream start order: request tags
const arrived = {};        // tag -> upstream arrival time
const ended = [];
let gate, upSrv, ocSrv, seatsDir;
let stubLoaded = 'modelA'; // the model the stub llama-swap reports as running

const sessions = { ses_cos: 'chief-of-staff', ses_build: 'build' };

before(async () => {
  seatsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-seats-'));
  fs.writeFileSync(path.join(seatsDir, 'chief-of-staff.md'), '');
  upSrv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/running') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ running: stubLoaded ? [{ model: stubLoaded, state: 'ready' }] : [] }));
    }
    if (u.pathname === '/health') { res.writeHead(200); return res.end('{"status":"ok"}'); }
    const up = u.pathname.match(/^\/upstream\/([^/]+)(\/.*)?$/);
    if (up) {
      const m = decodeURIComponent(up[1]);
      if (m !== stubLoaded) { res.writeHead(409); return res.end('model not loaded'); }
      if (up[2] === '/status') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"busy": false, "queued": 0}'); }
      if (up[2] === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"status":"ok","loaded":true}'); }
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}');
    }
    if (u.pathname === '/status') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"busy": false, "queued": 0}'); }
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      const j = JSON.parse(b);
      const { tag, ms } = j;
      stubLoaded = j.model || stubLoaded || 'modelA';
      order.push(tag);
      arrived[tag] = Date.now();
      res.writeHead(200, { 'content-type': 'application/json' });
      const t = setTimeout(() => { ended.push(tag); res.end(JSON.stringify({ tag })); }, ms);
      res.on('close', () => clearTimeout(t));
    });
  }).listen(UP, '127.0.0.1');
  ocSrv = http.createServer((req, res) => {
    const sid = req.url.split('/').pop();
    if (!sessions[sid]) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: { id: sid, agent: sessions[sid] } }));
  }).listen(OC, '127.0.0.1');
  gate = spawn(process.execPath, [new URL('../gate/gate.mjs', import.meta.url).pathname], {
    env: { ...process.env, GATE_PORT: String(GATE), GATE_UPSTREAM_PORT: String(UP), GATE_OPENCODE_URL: `http://127.0.0.1:${OC}`,
      GATE_SEATS_DIR: seatsDir, OWNER_GRACE_S: String(GRACE_S), GATE_RUNNING_POLL_MS: '100' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((r) => gate.stdout.on('data', (d) => String(d).includes('listening') && r()));
});

after(() => { gate.kill(); upSrv.close(); ocSrv.close(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function gen(tag, ms, headers = {}, model) {
  return fetch(`http://127.0.0.1:${GATE}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(model ? { tag, ms, model } : { tag, ms }),
  }).then((r) => r.json());
}
const seat = { 'x-opencode-session': 'ses_cos' };
const owner = { 'x-opencode-session': 'ses_build' };
const reset = async () => { order.length = 0; ended.length = 0; stubLoaded = 'modelA'; await sleep(GRACE_S * 1000 + 300); };

test('a seat request typed between two owner steps waits for the owner to finish', async () => {
  await reset();
  await gen('owner-step-1', 100, owner);
  const s = gen('seat', 50, seat);            // arrives in the gap between owner steps
  await sleep(300);
  await gen('owner-step-2', 100, owner);      // owner's next step still goes first
  await s;
  assert.deepEqual(order, ['owner-step-1', 'owner-step-2', 'seat']);
});

test('a waiting owner request goes before an earlier queued seat request', async () => {
  await reset();
  const a = gen('seat-running', 400, seat);
  await sleep(50);
  const b = gen('seat-queued', 50, seat);
  await sleep(50);
  const c = gen('owner', 50, { 'x-strata-class': 'owner' });
  await Promise.all([a, b, c]);
  assert.deepEqual(order, ['seat-running', 'owner', 'seat-queued']);
});

test('a client that leaves while queued never reaches Strata', async () => {
  await reset();
  const a = gen('running', 300, seat);
  await sleep(50);
  const ac = new AbortController();
  const gone = fetch(`http://127.0.0.1:${GATE}/v1/chat/completions`, {
    method: 'POST', signal: ac.signal, headers: { 'content-type': 'application/json', ...seat }, body: JSON.stringify({ tag: 'left', ms: 10 }),
  }).catch(() => 'aborted');
  await sleep(50);
  ac.abort();
  assert.equal(await gone, 'aborted');
  await a;
  await sleep(100);
  assert.deepEqual(order, ['running']);
});

test('GET /status counts the gate queue; health passes while a generation runs', async () => {
  await reset();
  const a = gen('long', 500, seat);
  await sleep(50);
  const b = gen('waiting', 10, seat);
  await sleep(50);
  const st = await fetch(`http://127.0.0.1:${GATE}/status`).then((r) => r.json());
  assert.equal(st.busy, true);
  assert.equal(st.queued, 1);
  const h = await fetch(`http://127.0.0.1:${GATE}/health`);
  assert.equal(h.status, 200);
  await Promise.all([a, b]);
});

test('a session the box server does not know (the Mac) is owner', async () => {
  await reset();
  const a = gen('seat-running', 300, seat);
  await sleep(50);
  const b = gen('seat-queued', 10, seat);
  await sleep(50);
  const c = gen('mac', 10, { 'x-opencode-session': 'ses_unknown_mac' });
  await Promise.all([a, b, c]);
  assert.deepEqual(order, ['seat-running', 'mac', 'seat-queued']);
});

test('GET /status keeps Strata\'s spacing, so an idle check that greps the raw text still matches', async () => {
  await reset();
  const raw = await fetch(`http://127.0.0.1:${GATE}/status`).then((r) => r.text());
  assert.ok(raw.includes('"busy": false, "queued": 0'), raw);
  assert.equal(JSON.parse(raw).gate.running, null);
});

// A seat job that names a different model would swap the loaded one. During
// owner grace it may not: it waits the same window as every seat. An owner
// job may swap as soon as nothing is running.
test('a seat swap waits out owner grace; an owner swap does not', async () => {
  await reset();
  stubLoaded = 'modelA';
  await sleep(150); // the /running poll picks up modelA
  await gen('owner-step', 100, owner, 'modelA');      // ends, owner grace starts
  const t0 = Date.now();
  const s = gen('seat-swap', 10, seat, 'modelB');     // seat asking for the other model
  const o = gen('owner-swap', 10, { 'x-strata-class': 'owner' }, 'modelB');
  await Promise.all([s, o]);
  assert.deepEqual(order, ['owner-step', 'owner-swap', 'seat-swap']);
  assert.ok(arrived['seat-swap'] - t0 >= GRACE_S * 1000 - 100,
    `seat-swap reached upstream after ${arrived['seat-swap'] - t0}ms (< grace)`);
  assert.equal(stubLoaded, 'modelB');
});

// /gate/status.loaded_model follows llama-swap's /running, and /status keeps
// the greppable idle shape when nothing is loaded.
test('loaded_model is reported; /status stays greppable with no model loaded', async () => {
  await reset();
  stubLoaded = null;
  await sleep(300);
  const g = await fetch(`http://127.0.0.1:${GATE}/gate/status`).then((r) => r.json());
  assert.equal(g.loaded_model, null);
  const raw = await fetch(`http://127.0.0.1:${GATE}/status`).then((r) => r.text());
  assert.ok(raw.includes('"busy": false, "queued": 0'), raw);
  await gen('warm', 10, owner, 'modelC');
  await sleep(300);
  const g2 = await fetch(`http://127.0.0.1:${GATE}/gate/status`).then((r) => r.json());
  assert.equal(g2.loaded_model, 'modelC');
});
