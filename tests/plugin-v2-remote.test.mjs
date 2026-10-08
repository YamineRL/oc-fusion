// Remote-mode tests for plugins/fusion/index.js.
//
// Remote mode is what a host without systemd gets: llama-server runs on
// another machine (a tunnel endpoint, typically) and the only contract is
// HTTP. The plugin must then discover it passively - GET /v1/models for
// residency and GET /props for context - use the configured base URL for
// its own llama.cpp calls, and take the effort fallback from the panel's
// "server_effort". None of that exists when the plugin assumes a local
// unit + `ps`, which is the pre-remote behavior these tests pin down.
//
// The seam is the one the host environment already owns: FUSION_UNIT names
// the unit path (absent here -> remote), FUSION_BASE_URL forces remote even
// with a unit present, and provider.llamacpp.options.baseURL in the project
// config supplies the endpoint when the env var does not. The llama-server
// stub is a real node:http server: /v1/models and /props only, plus a
// logged /v1/chat/completions so the summarizer path is observable.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-remote-"));
const BIN = path.join(ROOT, "bin");
fs.mkdirSync(BIN, { recursive: true });

// `ps` answers nothing: if any code path still trusts cmdline scraping it
// must find no resident model, which is exactly a remote host's reality.
fs.writeFileSync(path.join(BIN, "ps"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

// FUSION_UNIT names a path that stays absent unless a test writes it: absent
// is what triggers remote mode when FUSION_BASE_URL is not set.
const UNIT_PATH = path.join(ROOT, "llama-server.service");
fs.writeFileSync(path.join(ROOT, "api-key"), "test-key\n");
fs.writeFileSync(path.join(ROOT, "strata-key"), "strata-test-key\n");

process.env.PATH = `${BIN}:${process.env.PATH}`;
process.env.FUSION_UNIT = UNIT_PATH;
process.env.FUSION_API_KEY_FILE = path.join(ROOT, "api-key");
process.env.FUSION_STRATA_URL = "http://127.0.0.1:18082";
process.env.FUSION_STRATA_KEY_FILE = path.join(ROOT, "strata-key");

// --- the remote llama-server stub -----------------------------------------
// Residency and context are all it has to answer; every request is logged so
// tests can prove the plugin probed passively and posted nowhere else.
const requests = [];
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    let json = null;
    try { json = JSON.parse(body); } catch {}
    requests.push({ method: req.method, path: req.url, json });
    const send = (obj) => {
      const b = JSON.stringify(obj);
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(b) });
      res.end(b);
    };
    if (req.method === "GET" && req.url === "/v1/models") {
      return send({
        object: "list",
        data: [
          { id: "remote-q", object: "model", status: { value: "loaded", args: ["--ctx-size", "49152", "--parallel", "2"] } },
          { id: "remote-idle", object: "model", status: { value: "unloaded", args: [] } },
        ],
      });
    }
    if (req.method === "GET" && req.url === "/props") {
      return send({ default_generation_settings: { n_ctx_slot: 24576 }, total_slots: 2 });
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      return send({ choices: [{ message: { content: "- compressed the middle" } }] });
    }
    res.writeHead(404).end("{}");
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}/v1`;
test.after(() => server.close());

const fusion = (await import("../plugins/fusion/index.js")).default;

function makeDir(profile = {}) {
  const dir = fs.mkdtempSync(path.join(ROOT, "proj-"));
  fs.writeFileSync(path.join(dir, "fusion.jsonc"), JSON.stringify(profile, null, 2));
  fs.writeFileSync(
    path.join(dir, "opencode.jsonc"),
    JSON.stringify(
      {
        provider: {
          llamacpp: {
            options: { baseURL: BASE },
            models: {
              "fusion-sidekick": { id: "local" },
              "fusion-sidekick-deep": { id: "local" },
            },
          },
        },
      },
      null,
      2,
    ),
  );
  return dir;
}

// Minimal fake of the v2 promise-adapter ctx: enough to run setup, replay
// the model transform against a seeded registry, and fire hooks.
function fakeCtx(dir) {
  const hooks = new Map();
  const tools = new Map();
  const transforms = { agent: [], model: [], mcp: [] };
  const hook = (name) => (cb, opts) => {
    const l = hooks.get(name) ?? [];
    l.push({ cb, opts });
    hooks.set(name, l);
    return Promise.resolve({ dispose() {} });
  };
  const toolEditor = {
    list: () => [...tools.values()],
    get: (id) => tools.get(id),
    add: (t) => tools.set(t.name, t),
    update: () => {},
    remove: (id) => tools.delete(id),
    namespace: () => {},
  };
  const ctx = {
    location: { directory: dir },
    agent: { transform: (cb) => { transforms.agent.push(cb); return Promise.resolve({ dispose() {} }); } },
    model: { transform: (cb) => { transforms.model.push(cb); return Promise.resolve({ dispose() {} }); } },
    mcp: { transform: (cb) => { transforms.mcp.push(cb); return Promise.resolve({ dispose() {} }); } },
    tool: {
      transform: (cb) => { cb(toolEditor); return Promise.resolve({ dispose() {} }); },
      list: async () => [...tools.values()],
      hook: (name, cb) => hook(`tool:${name}`)(cb),
    },
    session: { hook: (name, cb, opts) => hook(`session:${name}`)(cb, opts) },
    permission: { hook: (n, cb) => hook(`permission:${n}`)(cb), list: async () => [], get: async () => undefined, reply: async () => ({}) },
    event: { subscribe: () => ({ async *[Symbol.asyncIterator]() { await new Promise(() => {}); } }) },
  };
  return {
    ctx,
    transforms,
    fire: async (name, event) => { for (const { cb } of hooks.get(name) ?? []) await cb(event); },
    fireScoped: async (name, event) => {
      for (const { cb, opts } of hooks.get(name) ?? []) {
        if (opts?.providerID && event.model?.providerID !== opts.providerID) continue;
        await cb(event);
      }
    },
  };
}

const modelEditor = (map) => ({
  list: (p) => [...map.values()].filter((m) => !p || m.providerID === p),
  get: (p, i) => map.get(`${p}/${i}`),
  update: (p, i, fn) => { const k = `${p}/${i}`; if (!map.has(k)) map.set(k, { id: i, providerID: p }); fn(map.get(k)); },
  remove: (p, i) => map.delete(`${p}/${i}`),
  default: { get: () => undefined, set: () => {} },
});

test("remote mode (no unit): residency and context come from the endpoint", async () => {
  const dir = makeDir({ sidekick: "local", critic: "local" });
  const h = fakeCtx(dir);
  await fusion.setup(h.ctx);

  // Passive discovery only: the endpoint saw the two GETs and nothing else.
  const seen = requests.map((r) => `${r.method} ${r.path}`);
  assert.ok(seen.includes("GET /v1/models"), `expected GET /v1/models, saw: ${seen.join(", ")}`);
  assert.ok(seen.includes("GET /props"), `expected GET /props, saw: ${seen.join(", ")}`);
  assert.ok(!seen.some((s) => s.startsWith("POST")), `remote discovery must never POST: ${seen.join(", ")}`);

  // The transform replays over the registry the config would have built:
  // the "local" placeholder resolves to the endpoint's resident id, and the
  // context clamp follows /props (24576 per slot x 2 slots = 49152 total,
  // 1024 reserved per slot).
  const models = new Map([
    ["llamacpp/fusion-sidekick", { id: "fusion-sidekick", providerID: "llamacpp", modelID: "local", limit: { context: 44000, output: 16384 } }],
  ]);
  for (const cb of h.transforms.model) cb(modelEditor(models));
  const m = models.get("llamacpp/fusion-sidekick");
  assert.equal(m.modelID, "remote-q");
  assert.equal(m.limit.context, 23552);
  assert.equal(m.limit.output, 11776);
});

test("remote mode: per-agent effort falls back to server_effort, wire id is the resident one", async () => {
  const dir = makeDir({
    sidekick: "local",
    critic: "local",
    local_efforts: { scout: "low" },
    server_effort: "high",
  });
  const h = fakeCtx(dir);
  await fusion.setup(h.ctx);

  const send = async (agent) => {
    const req = new Request(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "local", messages: [] }),
    });
    const ev = { sessionID: "s1", agent, model: { providerID: "llamacpp", id: "fusion-sidekick" }, kind: "primary", request: req };
    await h.fireScoped("session:http.request", ev);
    return JSON.parse(await ev.request.text());
  };

  const grunt = await send("grunt");
  assert.equal(grunt.model, "remote-q");
  assert.equal(grunt.chat_template_kwargs.reasoning_effort, "high");
  const scout = await send("scout");
  assert.equal(scout.chat_template_kwargs.reasoning_effort, "low");
});

test("remote mode via FUSION_BASE_URL: compression posts to the endpoint, not a local port", async () => {
  // A unit exists here (--port 18080, dead), so only FUSION_BASE_URL may put
  // the plugin in remote mode: the unit's port is exactly what the old code
  // would have dialed.
  fs.writeFileSync(
    UNIT_PATH,
    ["[Service]", "ExecStart=/fake/bin/llama-server --port 18080 -c 44032 --parallel 1 --models-max 1", ""].join("\n"),
  );
  process.env.FUSION_BASE_URL = BASE;
  try {
    const dir = makeDir({ sidekick: "local", critic: "local", compress_threshold: 5000 });
    const h = fakeCtx(dir);
    await fusion.setup(h.ctx);

    const before = requests.filter((r) => r.method === "POST").length;
    const ev = {
      sessionID: "s1",
      agent: "fusion",
      messageID: "m1",
      id: "call-1",
      tool: "read",
      input: { filePath: "big.log" },
      status: "completed",
      result: { content: "x".repeat(20000) },
    };
    await h.fire("tool:execute.after", ev);

    assert.match(ev.result.content, /summarized by the local model/);
    const posts = requests.filter((r) => r.method === "POST" && r.path === "/v1/chat/completions").slice(before);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].json.model, "remote-q");
  } finally {
    delete process.env.FUSION_BASE_URL;
    fs.rmSync(UNIT_PATH, { force: true });
  }
});
