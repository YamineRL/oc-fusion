#!/usr/bin/env node
// strata-gate: the one queue in front of llama-swap.
//
// Every client (box opencode server and its TUIs, the Mac tunnel, Open WebUI,
// ClaudeVille, anything added later) talks to :8082. llama-swap listens on
// :8091 and owns the model processes (Strata :8092, llama-server :8093).
// Generation requests go through one queue here, so the same rules hold for
// every interface:
//
// 1. One generation at a time. A running request is never cut off.
// 2. Two classes: owner and seat. A waiting owner request always goes first.
// 3. Owner grace: after an owner request ends, seat requests wait OWNER_GRACE_S
//    more seconds. An agent loop sends its next step within seconds, so a seat
//    cannot slip in between two owner steps (that also costs the owner a full
//    prompt re-read, because the seat prompt replaces Strata's prompt cache).
// 4. Swaps: a request names a model, llama-swap loads it and evicts the other
//    server. A seat request that names a model different from the loaded one
//    must not cause a swap while an owner request ran in the last
//    OWNER_GRACE_S seconds: it waits like every seat request. An owner
//    request can always cause a swap, but only after the running generation
//    ends (rule 1).
//
// Class of a request, first match wins:
//   a. header `X-Strata-Class: seat|owner` (for future clients),
//   b. header `x-opencode-session` (opencode v2 sends it): the session's agent
//      on the box opencode server is a seat agent -> seat,
//   c. anything else -> owner.
//
// Non-generation paths: llama-swap's own API passes through unchanged
// (/v1/models, /running, /logs, /ui, /api/*, ...). Backend paths (/slots,
// /settings, /props, the web UI, static files) are mapped onto
// /upstream/<loaded model>/ so they always reach the server that is loaded.
// GET /status is passed to the loaded Strata with the gate queue added to
// "busy"/"queued", so existing idle checks see queued work; with no model or
// a non-Strata model loaded the gate writes the same shape itself.
// GET /gate/status shows the queue and the loaded model.

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

const env = process.env;
const LISTEN_HOST = env.GATE_HOST || '127.0.0.1';
const LISTEN_PORT = Number(env.GATE_PORT || 8082);
const UP_HOST = env.GATE_UPSTREAM_HOST || '127.0.0.1';
const UP_PORT = Number(env.GATE_UPSTREAM_PORT || 8091);
const OPENCODE_URL = env.GATE_OPENCODE_URL || 'http://127.0.0.1:4095';
const SEATS_DIR = env.GATE_SEATS_DIR || '';
const OWNER_GRACE_MS = Number(env.OWNER_GRACE_S ?? 180) * 1000;
const KEEPALIVE_MS = Number(env.GATE_KEEPALIVE_S ?? 15) * 1000;
const RUNNING_POLL_MS = Number(env.GATE_RUNNING_POLL_MS ?? 1500);

// llama-swap's model-dispatched routes: a request to one of these names a
// model and can start a swap, so it goes through the gate queue.
const GATED_POST = new Set([
  '/v1/chat/completions', '/v1/completions', '/v1/messages', '/v1/responses',
  '/v1/messages/count_tokens', '/v1/embeddings',
  '/v1/audio/speech', '/v1/audio/voices', '/v1/audio/transcriptions',
  '/v1/images/generations', '/v1/images/edits',
  '/infill', '/completion', '/rerank', '/reranking', '/v1/rerank', '/v1/reranking',
  '/sdapi/v1/txt2img', '/sdapi/v1/img2img', '/audioapi/v1/tasks/run',
]);
// Model-dispatched GETs carry the model in ?model=.
const GATED_GET = new Set(['/props', '/v1/audio/voices', '/sdapi/v1/loras']);

// Paths that are llama-swap's own API, not the loaded backend's. They pass
// through unchanged so /v1/models lists every model and /ui stays reachable.
function isSwapPath(p) {
  return p === '/' || p === '/v1/models' || p === '/models' || p === '/running'
    || p === '/unload' || p === '/metrics' || p === '/wol-health' || p === '/favicon.ico'
    || p.startsWith('/logs') || p.startsWith('/ui') || p.startsWith('/api/')
    || p.startsWith('/comfyui');
}

const log = (...a) => console.log('[gate]', ...a);

// ── seat agents: the file names in bureau/seats, plus GATE_SEAT_AGENTS ──
function seatAgents() {
  const names = new Set((env.GATE_SEAT_AGENTS || '').split(',').map((s) => s.trim()).filter(Boolean));
  try {
    for (const f of fs.readdirSync(SEATS_DIR)) if (f.endsWith('.md')) names.add(path.basename(f, '.md'));
  } catch { /* no seats dir: only the env list */ }
  return names;
}
let seats = seatAgents();
setInterval(() => { seats = seatAgents(); }, 60_000).unref();

// ── session -> agent lookup on the box opencode server ──
const agentCache = new Map(); // sid -> { agent, at }
async function sessionAgent(sid) {
  const hit = agentCache.get(sid);
  const ttl = hit?.agent ? 600_000 : 60_000;
  if (hit && Date.now() - hit.at < ttl) return hit.agent;
  let agent = null;
  try {
    const r = await fetch(`${OPENCODE_URL}/api/session/${encodeURIComponent(sid)}`, { signal: AbortSignal.timeout(2000) });
    if (r.ok) agent = (await r.json())?.data?.agent || null;
  } catch { /* server down or slow: unknown, treated as owner */ }
  agentCache.set(sid, { agent, at: Date.now() });
  return agent;
}

async function classify(req) {
  const explicit = String(req.headers['x-strata-class'] || '').toLowerCase();
  if (explicit === 'seat' || explicit === 'owner') return { cls: explicit, who: `header` };
  const sid = req.headers['x-opencode-session'];
  if (sid) {
    const agent = await sessionAgent(String(sid));
    if (agent && seats.has(agent)) return { cls: 'seat', who: `${agent} ${sid}` };
    return { cls: 'owner', who: `${agent || 'session'} ${sid}` };
  }
  return { cls: 'owner', who: req.headers['user-agent']?.slice(0, 40) || 'client' };
}

// ── loaded model: llama-swap's /running is the truth ──
let loadedModel = null;
async function refreshLoaded() {
  try {
    const r = await fetch(`http://${UP_HOST}:${UP_PORT}/running`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return;
    const j = await r.json();
    const list = Array.isArray(j?.running) ? j.running : [];
    // A swap in flight can briefly list two: the one starting is the truth.
    const pick = list.find((m) => m.state === 'starting') || list.find((m) => m.state === 'ready') || list[0];
    loadedModel = pick?.model || null;
  } catch { /* llama-swap down: keep the last known value */ }
}
setInterval(refreshLoaded, RUNNING_POLL_MS).unref();
refreshLoaded();

// ── the queue ──
const queue = [];      // { cls, who, model, enq, start, id }
let running = null;    // { cls, who, model, since, id }
let lastOwnerAt = 0;   // end (or start) of the newest owner request
let graceTimer = null;
let nextId = 1;

// Milliseconds a queued seat job must still wait. During owner grace no seat
// starts at all. The swap rule is the same window: a seat job that names a
// model different from the loaded one would evict the owner's model, so it
// too may not start while an owner request ran in the last OWNER_GRACE_S.
// job.swap records the comparison so the hold's reason is visible in logs and
// /gate/status.
function seatHoldMs(job) {
  if (job.cls === 'owner') return 0;
  job.swap = job.model !== loadedModel;
  return Math.max(0, lastOwnerAt + OWNER_GRACE_MS - Date.now());
}

function pickNext() {
  if (running || !queue.length) return;
  const owner = queue.findIndex((q) => q.cls === 'owner');
  let i = owner;
  if (i < 0) {
    const wait = seatHoldMs(queue[0]);
    if (wait > 0) {
      clearTimeout(graceTimer);
      graceTimer = setTimeout(pickNext, wait + 50);
      return;
    }
    i = 0;
  }
  const [job] = queue.splice(i, 1);
  running = { cls: job.cls, who: job.who, model: job.model, since: Date.now(), id: job.id };
  if (job.cls === 'owner') lastOwnerAt = Date.now();
  const waited = Math.round((Date.now() - job.enq) / 1000);
  log(`start #${job.id} ${job.cls} model=${job.model} (${job.who}) waited ${waited}s, queue owner ${count('owner')} seat ${count('seat')}`);
  job.start();
}

function release(id) {
  if (!running || running.id !== id) return;
  if (running.cls === 'owner') lastOwnerAt = Date.now();
  log(`end #${id} ${running.cls} model=${running.model} after ${Math.round((Date.now() - running.since) / 1000)}s`);
  running = null;
  setImmediate(pickNext);
}

const count = (cls) => queue.filter((q) => q.cls === cls).length;

function statusJson() {
  const now = Date.now();
  return {
    running: running && { ...running, for_s: Math.round((now - running.since) / 1000) },
    queue: queue.map((q, pos) => ({ pos, id: q.id, cls: q.cls, who: q.who, model: q.model, swap: q.cls === 'seat' && q.model !== loadedModel, waiting_s: Math.round((now - q.enq) / 1000) })),
    owner_grace_s: OWNER_GRACE_MS / 1000,
    seats_held_for_s: Math.max(0, Math.round((lastOwnerAt + OWNER_GRACE_MS - now) / 1000)),
    loaded_model: loadedModel,
    seat_agents: [...seats],
  };
}

// ── proxy ──
function upstream(req, body, onResponse, onError, pathOverride) {
  const up = http.request({ host: UP_HOST, port: UP_PORT, method: req.method, path: pathOverride || req.url, headers: req.headers }, onResponse);
  up.on('error', onError);
  if (body) up.end(body); else req.pipe(up);
  return up;
}

function passThrough(req, res, pathOverride) {
  const up = upstream(req, null, (ur) => {
    res.writeHead(ur.statusCode, ur.headers);
    ur.pipe(res);
  }, (e) => fail(res, 502, `strata-gate: llama-swap (:${UP_PORT}) is not answering: ${e.code || e.message}`), pathOverride);
  res.on('close', () => up.destroy());
}

function fail(res, code, message) {
  if (res.headersSent) { res.end(); return; }
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { type: 'gate_error', message } }));
}

function upstreamGet(path, headers) {
  return new Promise((resolve) => {
    const h = { ...headers };
    delete h.host; // our request, not a client forward
    const up = http.request({ host: UP_HOST, port: UP_PORT, method: 'GET', path, headers: h }, (ur) => {
      const chunks = [];
      ur.on('data', (c) => chunks.push(c));
      ur.on('end', () => resolve({ status: ur.statusCode, text: Buffer.concat(chunks).toString(), headers: ur.headers }));
    });
    up.on('error', () => resolve({ status: 0, text: '' }));
    up.end();
  });
}

// The idle status shape Strata writes, produced by the gate when the loaded
// model is not Strata or nothing is loaded. Idle checks grep the raw text
// `"busy": false, "queued": 0`; keep the exact spacing.
function syntheticStatus() {
  const busy = running ? 'true' : 'false';
  return `{"busy": ${busy}, "queued": ${queue.length}, "gate": ${JSON.stringify(statusJson())}}`;
}

// GET /status: the loaded model's own /status through llama-swap's
// /upstream/<model>/ passthrough, with the gate queue added to busy/queued.
// Anything that is not Strata's shape falls back to the synthetic answer.
async function statusMerged(req, res) {
  const merge = (text) => {
    try {
      const j = JSON.parse(text);
      if (!(j && typeof j === 'object' && !Array.isArray(j) && 'busy' in j)) return null;
      if (running) text = text.replace(/"busy":(\s*)false/, '"busy":$1true');
      if (queue.length) text = text.replace(/"queued":(\s*)(\d+)/, (m, sp, n) => `"queued":${sp}${Number(n) + queue.length}`);
      return text.replace(/\}\s*$/, `, "gate": ${JSON.stringify(statusJson())}}`);
    } catch { return null; }
  };
  let text = null;
  if (loadedModel) {
    const up = await upstreamGet(`/upstream/${encodeURIComponent(loadedModel)}/status`, req.headers);
    if (up.status === 200) text = merge(up.text);
  }
  const out = text ?? syntheticStatus();
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(out);
}

// GET /health: the loaded backend's /health (never triggers a load, the path
// is in llama-swap's upstream.ignorePaths), else llama-swap's own OK.
async function healthMerged(req, res) {
  if (!loadedModel) return passThrough(req, res);
  const up = await upstreamGet(`/upstream/${encodeURIComponent(loadedModel)}/health`, req.headers);
  if (up.status === 0) return passThrough(req, res);
  res.writeHead(up.status, { 'content-type': up.headers?.['content-type'] || 'application/json' });
  res.end(up.text);
}

async function gated(req, res, forcedModel) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  let stream = false;
  let model = forcedModel ?? null;
  try {
    const j = JSON.parse(body);
    stream = j.stream === true;
    if (!forcedModel && typeof j.model === 'string') model = j.model;
  } catch { /* not JSON */ }
  if (!forcedModel && req.method === 'GET') {
    model = new URL(req.url, 'http://x').searchParams.get('model') || model;
  }
  const anthropic = req.url.split('?')[0] === '/v1/messages';
  const { cls, who } = await classify(req);
  const id = nextId++;
  let gone = false;
  let keepalive = null;

  const job = { cls, who, model, enq: Date.now(), id, start: null };
  res.on('close', () => {
    gone = true;
    clearInterval(keepalive);
    const i = queue.indexOf(job);
    if (i >= 0) { queue.splice(i, 1); log(`drop #${id} ${cls} (${who}): client left while queued`); }
  });

  // A streaming client that waits sees SSE comments, so its read timeout
  // does not fire. Comments are ignored by every SSE parser.
  const startKeepalive = () => {
    if (!stream || gone || res.headersSent) return;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const ping = () => res.write(`: strata-gate: queued as ${cls}, position ${queue.indexOf(job) + 1}\n\n`);
    ping();
    keepalive = setInterval(ping, KEEPALIVE_MS);
  };
  const kaTimer = setTimeout(startKeepalive, Math.min(KEEPALIVE_MS, 10_000));

  job.start = () => {
    clearTimeout(kaTimer);
    clearInterval(keepalive);
    if (gone) { release(id); return; }
    const up = upstream(req, body, (ur) => {
      if (!res.headersSent) {
        res.writeHead(ur.statusCode, ur.headers);
        ur.pipe(res);
      } else if (ur.statusCode === 200) {
        ur.pipe(res);
      } else {
        // Headers already went out as 200 SSE: report the error as an event.
        const errChunks = [];
        ur.on('data', (c) => errChunks.push(c));
        ur.on('end', () => {
          let err;
          try { err = JSON.parse(Buffer.concat(errChunks)).error; } catch { err = null; }
          err = err || { message: `llama-swap answered HTTP ${ur.statusCode}` };
          res.end(anthropic
            ? `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: err.type || 'api_error', message: err.message || String(err) } })}\n\n`
            : `data: ${JSON.stringify({ error: err })}\n\n`);
        });
      }
      ur.on('end', () => release(id));
      ur.on('error', () => release(id));
    }, (e) => {
      if (res.headersSent) res.end(`data: ${JSON.stringify({ error: { message: `strata-gate: ${e.message}` } })}\n\n`);
      else fail(res, 502, `strata-gate: llama-swap (:${UP_PORT}) is not answering: ${e.code || e.message}`);
      release(id);
    });
    res.on('close', () => { up.destroy(); release(id); });
  };

  if (gone) return;
  queue.push(job);
  refreshLoaded();
  if (running || queue.length > 1 || cls === 'seat') log(`queue #${id} ${cls} model=${model} (${who}), running ${running ? running.cls : 'none'}, queue ${queue.length}`);
  pickNext();
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname.replace(/\/+$/, '') || '/';
  if (req.method === 'GET' && p === '/gate/status') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(statusJson(), null, 1));
  }
  if (req.method === 'GET' && p === '/status') return void statusMerged(req, res);
  if (req.method === 'GET' && p === '/health') return void healthMerged(req, res);

  // /upstream/<model>/... : direct backend access. It can never start a load
  // through the gate: a model other than the loaded one gets 409. A gated
  // POST under it still queues (it is a generation on the loaded model).
  if (p.startsWith('/upstream/')) {
    const rest = p.slice('/upstream/'.length);
    const mname = decodeURIComponent(rest.split('/')[0] || '');
    const inner = '/' + rest.slice(mname.length);
    if (req.method === 'POST' && GATED_POST.has(inner)) {
      if (mname !== loadedModel) return fail(res, 409, `strata-gate: model ${mname} is not loaded (loaded: ${loadedModel}); use /v1/... so the queue can swap`);
      return void gated(req, res, mname);
    }
    if (mname !== loadedModel) return fail(res, 409, `strata-gate: model ${mname} is not loaded (loaded: ${loadedModel})`);
    return passThrough(req, res);
  }

  // Model-dispatched requests go through the queue: they can start a swap.
  if (req.method === 'POST' && GATED_POST.has(p)) {
    gated(req, res).catch((e) => fail(res, 500, `strata-gate: ${e.message}`));
    return;
  }
  if (req.method === 'GET' && GATED_GET.has(p) && u.searchParams.has('model')) {
    gated(req, res).catch((e) => fail(res, 500, `strata-gate: ${e.message}`));
    return;
  }

  // llama-swap's own API and UI pass through unchanged.
  if (isSwapPath(p)) return passThrough(req, res);

  // Every other path belongs to the loaded backend (web UI, /slots,
  // /settings, /props without a model, static files, ...).
  if (!loadedModel) return fail(res, 503, 'strata-gate: no model is loaded');
  passThrough(req, res, `/upstream/${encodeURIComponent(loadedModel)}${req.url}`);
});
// WebSocket upgrades (llama-swap /logs, /ui) tunnel straight through.
server.on('upgrade', (req, socket, head) => {
  const up = net.connect(UP_PORT, UP_HOST, () => {
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n`);
    for (const [k, v] of Object.entries(req.headers)) up.write(`${k}: ${v}\r\n`);
    up.write('\r\n');
    if (head?.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});
server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.keepAliveTimeout = 5_000;
server.listen(LISTEN_PORT, LISTEN_HOST, () => log(`listening on ${LISTEN_HOST}:${LISTEN_PORT} -> llama-swap ${UP_HOST}:${UP_PORT}, owner grace ${OWNER_GRACE_MS / 1000}s, seats: ${[...seats].join(', ')}`));
