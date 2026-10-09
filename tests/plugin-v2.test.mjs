// Contract tests for the OpenCode v2 plugin shape of fusion.js.
//
// The plugin is exercised through its real public seam: `default.setup(ctx)`
// with a fake host context that mirrors the v2 promise adapter (transforms
// get a mutable editor, hooks get the event object, event.subscribe yields
// encoded events). Assertions land on what the harness observable behavior
// actually is: editor state, event mutations, and .fusion/*.jsonl lines.
//
// No network, no real model calls, no real llama-server: `ps` is stubbed via
// PATH so resident-model discovery is deterministic.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Environment is read at module load / setup() time, so fixtures land before
// the import. Each test gets its own directory (its own .fusion + profile).
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-v2-"));
const BIN = path.join(ROOT, "bin");
fs.mkdirSync(BIN, { recursive: true });

// A llama-server child whose --alias resolves as the resident model.
fs.writeFileSync(
  path.join(BIN, "ps"),
  '#!/bin/sh\nprintf "%s\\n" "/fake/bin/llama-server --alias resident-x --port 18080 -c 44032 --parallel 1 --models-max 1"\n',
  { mode: 0o755 },
);

fs.writeFileSync(
  path.join(ROOT, "llama-server.service"),
  [
    "[Service]",
    'ExecStart=/fake/bin/llama-server --port 18080 -c 44032 --parallel 1 --models-max 1 --chat-template-kwargs \'{"reasoning_effort":"medium"}\'',
    "",
  ].join("\n"),
);
fs.writeFileSync(path.join(ROOT, "api-key"), "test-key\n");
// Strata's key file, with a comment line first: only the first usable line
// may reach the Authorization header. The URL is a port nothing listens on.
fs.writeFileSync(path.join(ROOT, "strata-key"), "# strata\n-strata-test-key\n");

process.env.PATH = `${BIN}:${process.env.PATH}`;
process.env.FUSION_UNIT = path.join(ROOT, "llama-server.service");
process.env.FUSION_API_KEY_FILE = path.join(ROOT, "api-key");
process.env.FUSION_STRATA_URL = "http://127.0.0.1:18082";
process.env.FUSION_STRATA_KEY_FILE = path.join(ROOT, "strata-key");

const fusion = (await import("../plugins/fusion/index.js")).default;

function makeDir(profile = {}, opencodeCfg = null) {
  const dir = fs.mkdtempSync(path.join(ROOT, "proj-"));
  fs.writeFileSync(path.join(dir, "fusion.jsonc"), JSON.stringify(profile, null, 2));
  if (opencodeCfg) fs.writeFileSync(path.join(dir, "opencode.jsonc"), JSON.stringify(opencodeCfg, null, 2));
  return dir;
}

// Default opencode.jsonc content for cfgWireIds + the config post-pass:
// the llamacpp aliases declare the "local" placeholder wire id.
const defaultOpencodeCfg = {
  provider: {
    llamacpp: {
      models: {
        "fusion-sidekick": { id: "local" },
        "fusion-sidekick-fast": { id: "local" },
        "fusion-sidekick-deep": { id: "local" },
      },
    },
  },
};

// A fake v2 promise-adapter context.
//
// The important fidelity point is transform ordering: in the real runtime a
// State rebuild replays transforms in registration order on an EMPTY map,
// and the post-phase config builtin registers after file plugins. So the
// fake mirrors that: plugin transforms are stored at registration, and
// rebuild() runs them on a draft seeded with builtin-only entries, then a
// config pass merges the config-declared fields on top (like
// opencode.config.agent / opencode.config.provider do). Assertions then
// read the post-rebuild maps.
function fakeCtx(dir, seed = {}) {
  const builtinsAgents = seed.builtinAgents ?? {
    build: { id: "build", mode: "primary", permissions: [] },
    general: { id: "general", mode: "primary", permissions: [] },
    plan: { id: "plan", mode: "primary", permissions: [] },
    explore: { id: "explore", mode: "subagent", permissions: [] },
    compaction: { id: "compaction", mode: "subagent", permissions: [] },
    summary: { id: "summary", mode: "subagent", permissions: [] },
  };
  // Like opencode.jsonc, the sidekick seats declare no model: the plugin
  // routes them (see "sidekick routing" below, which reads the real file).
  const cfgAgents = seed.cfgAgents ?? {
    fusion: { model: { providerID: "merge-gateway", id: "zai/glm-5.3", variant: "high" }, mode: "primary", steps: 400 },
    scout: { mode: "subagent", steps: 60 },
    grunt: { mode: "subagent", steps: 80 },
    oracle: { model: { providerID: "merge-gateway", id: "anthropic/claude-fable-5-1", variant: "max" }, mode: "subagent", steps: 40 },
    critic: { mode: "subagent", steps: 40 },
    title: { model: { providerID: "merge-gateway", id: "zai/glm-5.3-flash" }, mode: "primary" },
  };
  const cfgModels = seed.cfgModels ?? {
    "llamacpp/fusion-sidekick": { modelID: "local", name: "Sidekick (medium effort)", limit: { context: 44000, output: 16384 } },
    "llamacpp/fusion-sidekick-deep": { modelID: "local", name: "Sidekick (high effort)", limit: { context: 44000, output: 32768 } },
    "merge-gateway/zai/glm-5.3": { modelID: "zai/glm-5.3" },
  };
  const cfgMcps = seed.cfgMcps ?? {};

  const agents = new Map();
  const models = new Map();
  const mcps = new Map();
  const tools = new Map();
  const hooks = new Map(); // "tool:execute.before" | "session:compaction" | ... -> [{cb, opts}]
  const transforms = { agent: [], model: [], mcp: [], tool: [] };
  const eventQueue = [];
  const eventWaiters = [];

  const agentDefaults = (id) => ({ id, mode: "primary", request: { settings: {}, headers: {}, body: {} }, permissions: [] });
  const agentEditor = (map) => ({
    list: () => [...map.values()],
    get: (id) => map.get(id),
    default: () => {},
    update: (id, fn) => { if (!map.has(id)) map.set(id, agentDefaults(id)); fn(map.get(id)); map.get(id).id = id; },
    remove: (id) => { map.delete(id); },
  });
  const modelDefaults = (p, i) => ({ id: i, providerID: p });
  const modelEditor = (map) => ({
    list: (providerID) => [...map.values()].filter((m) => !providerID || m.providerID === providerID),
    get: (p, i) => map.get(`${p}/${i}`),
    update: (p, i, fn) => { const k = `${p}/${i}`; if (!map.has(k)) map.set(k, modelDefaults(p, i)); fn(map.get(k)); },
    remove: (p, i) => map.delete(`${p}/${i}`),
    default: { get: () => undefined, set: () => {} },
  });
  const mcpEditor = (map) => ({
    list: () => [...map.entries()],
    get: (n) => map.get(n),
    update: (n, fn) => { if (!map.has(n)) map.set(n, { type: "local", command: [] }); fn(map.get(n)); },
    remove: (n) => map.delete(n),
  });
  const toolEditor = (map) => ({
    list: () => [...map.values()],
    get: (id) => map.get(id),
    namespace: () => {},
    add: (t) => map.set(t.name, t),
    update: (id, fn) => { const t = map.get(id); if (t) fn(t); },
    remove: (id) => map.delete(id),
  });

  // Mirrors opencode.config.agent (a post builtin): after every plugin
  // transform, declared config fields are written back on top.
  const configAgentPass = (ed) => {
    for (const [id, item] of Object.entries(cfgAgents)) {
      if (item.disabled) { ed.remove(id); continue; }
      ed.update(id, (a) => {
        if (item.model !== undefined) a.model = item.model;
        if (item.mode !== undefined) a.mode = item.mode;
        if (item.steps !== undefined) a.steps = item.steps;
        if (item.description !== undefined) a.description = item.description;
        if (item.system !== undefined) a.system = item.system;
        if (item.hidden !== undefined) a.hidden = item.hidden;
        if (item.request !== undefined) {
          Object.assign(a.request.headers, item.request.headers ?? {});
          Object.assign(a.request.body, item.request.body ?? {});
        }
        if (item.permissions !== undefined) a.permissions.push(...item.permissions);
      });
    }
  };
  const configModelPass = (ed) => {
    for (const [key, item] of Object.entries(cfgModels)) {
      const i = key.indexOf("/");
      ed.update(key.slice(0, i), key.slice(i + 1), (m) => {
        if (item.modelID !== undefined) m.modelID = item.modelID;
        if (item.name !== undefined) m.name = item.name;
        if (item.limit !== undefined) m.limit = item.limit;
      });
    }
  };
  const configMcpPass = (ed) => {
    for (const [n, item] of Object.entries(cfgMcps)) {
      ed.update(n, (m) => Object.assign(m, item));
    }
  };

  const rebuild = () => {
    const aDraft = new Map(Object.entries(builtinsAgents).map(([k, v]) => [k, { ...v }]));
    const aEd = agentEditor(aDraft);
    for (const cb of transforms.agent) cb(aEd);
    configAgentPass(aEd);
    agents.clear(); for (const [k, v] of aDraft) agents.set(k, v);

    const mDraft = new Map();
    const mEd = modelEditor(mDraft);
    for (const cb of transforms.model) cb(mEd);
    configModelPass(mEd);
    models.clear(); for (const [k, v] of mDraft) models.set(k, v);

    const cDraft = new Map();
    const cEd = mcpEditor(cDraft);
    for (const cb of transforms.mcp) cb(cEd);
    configMcpPass(cEd);
    mcps.clear(); for (const [k, v] of cDraft) mcps.set(k, v);
  };

  const hook = (name) => (cb, opts) => {
    const list = hooks.get(name) ?? [];
    list.push({ cb, opts });
    hooks.set(name, list);
    return Promise.resolve({ dispose: () => {} });
  };

  // Registered RPC services: definition -> handlers, plus emitted events.
  // Mirrors ctx.rpc.register on the real host.
  const rpcServices = new Map();
  const rpcEmitted = [];

  const ctx = {
    location: { directory: dir },
    options: {},
    agent: {
      transform: (cb) => { transforms.agent.push(cb); return Promise.resolve({ dispose: () => {} }); },
      // The real host replays registered transforms on rebuild; the fake
      // does the same for every domain.
      reload: () => { rebuild(); return Promise.resolve(); },
    },
    model: {
      transform: (cb) => { transforms.model.push(cb); return Promise.resolve({ dispose: () => {} }); },
      reload: () => { rebuild(); return Promise.resolve(); },
    },
    mcp: { transform: (cb) => { transforms.mcp.push(cb); return Promise.resolve({ dispose: () => {} }); } },
    rpc: {
      register: (definition, handlers) => {
        rpcServices.set(definition.id, { definition, handlers });
        return Promise.resolve({
          dispose: () => {},
          events: { emit: (name, data) => { rpcEmitted.push({ rpc: definition.id, name, data }); return Promise.resolve(); } },
        });
      },
    },
    tool: {
      transform: (cb) => {
        cb(toolEditor(tools));
        return Promise.resolve({ dispose: () => {} });
      },
      list: () => Promise.resolve([...tools.values()]),
      hook: (name, cb) => hook(`tool:${name}`)(cb),
    },
    session: { hook: (name, cb, opts) => hook(`session:${name}`)(cb, opts) },
    permission: { hook: (n, cb) => hook(`permission:${n}`)(cb), list: async () => [], get: async () => undefined, reply: async () => ({}) },
    event: {
      subscribe: () => ({
        async *[Symbol.asyncIterator]() {
          while (true) {
            if (eventQueue.length) { yield eventQueue.shift(); continue; }
            const ev = await new Promise((r) => eventWaiters.push(r));
            yield ev;
          }
        },
      }),
    },
  };

  return {
    ctx,
    agents,
    models,
    mcps,
    tools,
    hooks,
    rpcServices,
    rpcEmitted,
    // Call a registered RPC method as the TUI client would.
    rpc: (method, input, callCtx = { error: (type, message, data) => ({ __rpcError: true, type, message, data }) }) =>
      rpcServices.get("fusion")?.handlers?.[method]?.(input ?? {}, callCtx),
    rebuild,
    emit: (ev) => (eventWaiters.length ? eventWaiters.shift()(ev) : eventQueue.push(ev)),
    fire: async (name, event) => {
      for (const { cb } of hooks.get(name) ?? []) await cb(event);
    },
    fireScoped: async (name, event) => {
      for (const { cb, opts } of hooks.get(name) ?? []) {
        if (opts?.providerID && event.model?.providerID !== opts.providerID) continue;
        await cb(event);
      }
    },
    // The hooks registered for one provider, called raw: as if the host's
    // provider filter had let a foreign request through.
    fireRegisteredFor: async (name, providerID, event) => {
      for (const { cb, opts } of hooks.get(name) ?? []) {
        if (opts?.providerID === providerID) await cb(event);
      }
    },
  };
}

const toolEvent = (over = {}) => ({
  sessionID: "s1",
  agent: "fusion",
  messageID: "m1",
  id: "call-1",
  input: {},
  ...over,
});

const controlLines = (dir) =>
  fs.existsSync(path.join(dir, ".fusion", "control.jsonl"))
    ? fs.readFileSync(path.join(dir, ".fusion", "control.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    : [];

const usageLines = (dir) =>
  fs.existsSync(path.join(dir, ".fusion", "usage.jsonl"))
    ? fs.readFileSync(path.join(dir, ".fusion", "usage.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    : [];

const settle = () => new Promise((r) => setTimeout(r, 30));

// The resident read is a live GET /v1/models at request time (the only
// passive route: it never names a model, so it cannot trigger a load).
// fetch is stubbed per test; the fake server's port is the unit's 18080.
const realFetch = globalThis.fetch;
const fetchOk = (ids) => async (url) => {
  if (!String(url).endsWith("/v1/models")) throw new Error(`unexpected fetch ${url}`);
  return { ok: true, status: 200, json: async () => ({ data: ids.map((id) => ({ id, status: { value: "loaded" } })) }) };
};
// Setup now probes the configured local backends (passive: /health and
// /v1/models only). The default answers "up" so existing behavior is
// deterministic; tests that want a down backend install their own stub.
const healthyBackend = async (url) => {
  const u = String(url);
  if (u.endsWith("/health")) {
    return { ok: true, status: 200, json: async () => ({ model: "qwen3.8-flash-next-iq3_xxs", max_context: 98304, loaded: true }) };
  }
  if (u.endsWith("/v1/models")) {
    return { ok: true, status: 200, json: async () => ({ data: [{ id: "resident-x", status: { value: "loaded" } }] }) };
  }
  throw new Error(`unexpected fetch ${u}`);
};
const stubFetch = (handler) => { globalThis.fetch = handler; };
test.beforeEach(() => { globalThis.fetch = healthyBackend; });
test.afterEach(() => { globalThis.fetch = realFetch; });

// ----------------------------------------------------------- setup shape

test("v2 setup: transform ordering, oracle hidden, tools, hooks", async () => {
  const dir = makeDir({ sidekick: "local", critic: "local" }, defaultOpencodeCfg);
  const h = fakeCtx(dir, {
    cfgMcps: { graft: { type: "local", command: ["oc-fusion", "graft", "mcp"] } },
  });
  await fusion.setup(h.ctx);
  h.rebuild();

  // Post-rebuild state mirrors production: config wins the fields it
  // declares, and the plugin's update() writes survive elsewhere.
  assert.deepEqual(h.agents.get("fusion").model, { providerID: "merge-gateway", id: "zai/glm-5.3", variant: "high" });
  assert.equal(h.agents.get("fusion").steps, 400);
  assert.equal(h.agents.get("fusion").mode, "primary");
  assert.deepEqual(h.agents.get("scout").model, { providerID: "llamacpp", id: "fusion-sidekick" });
  assert.deepEqual(h.agents.get("critic").model, { providerID: "llamacpp", id: "fusion-sidekick-deep" });

  // advise mode: the oracle stays listed (remove() cannot beat config) but
  // is hidden; dispatch refusal is the execute.before gate's job.
  assert.equal(h.agents.get("oracle").hidden, true);
  assert.equal(h.agents.get("oracle").mode, "subagent");

  // request.body is never declared by config, so the effort stamp survives.
  assert.equal(h.agents.get("scout").request.body.chat_template_kwargs.reasoning_effort, "low");
  assert.equal(h.agents.get("grunt").request.body.chat_template_kwargs.reasoning_effort, "medium");
  assert.equal(h.agents.get("critic").request.body.chat_template_kwargs.reasoning_effort, "high");
  assert.equal(h.agents.get("fusion").request.body.chat_template_kwargs, undefined);

  // modelID is config-declared ("local"), so config wins the registry; the
  // wire stamp happens on the request body in the http.request hook.
  assert.equal(h.models.get("llamacpp/fusion-sidekick").modelID, "local");
  assert.equal(h.models.get("llamacpp/fusion-sidekick").limit.context, 44000);

  // graft MCP: same ordering no-op; the config command stands and resolves
  // via PATH on the box.
  assert.deepEqual(h.mcps.get("graft").command, ["oc-fusion", "graft", "mcp"]);

  // Tools exist, callable directly (not only through CodeMode).
  for (const name of ["escalate", "work_order", "fusion_blocked"]) {
    assert.ok(h.tools.has(name), name);
    assert.equal(h.tools.get(name).options.codemode, false);
  }

  // All the hooks the v1 plugin relied on have v2 homes. The eviction guard
  // is llama.cpp only; the slot gate, request stamp and sampler strip exist
  // once per local provider (llamacpp, strata).
  const scopes = (name) => (h.hooks.get(name) ?? []).map((x) => x.opts?.providerID).sort();
  assert.deepEqual(scopes("session:model.request"), ["llamacpp", "llamacpp", "strata"]);
  assert.deepEqual(scopes("session:http.request"), ["llamacpp", "strata"]);
  for (const name of ["session:context", "session:generate", "session:title"]) {
    assert.deepEqual(scopes(name), ["llamacpp", "strata"], name);
  }
  assert.ok(h.hooks.get("session:compaction")?.length === 1);
  assert.ok(h.hooks.get("tool:execute.before")?.length === 1);
  assert.ok(h.hooks.get("tool:execute.after")?.length === 1);
});

// ------------------------------------------------------ plugin list

function repoConfig() {
  const text = fs.readFileSync(new URL("../opencode.jsonc", import.meta.url), "utf8");
  let out = "", inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) { out += c; if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; out += "\n"; continue; }
    out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

// `oc` runs opencode in the user's project, not in the harness, so the
// project-local auto-discovery never sees the harness plugins: only the
// config's `plugin` list loads them. v2 drops a file entry ("configured
// plugin path must be a directory") and v1 resolves a directory to its
// index, so each entry must be a directory with an index file. A plugin file
// left under .opencode/plugin(s)/ also auto-loads when opencode runs in the
// harness itself and fails there as a duplicate plugin ID.
test("plugin list: fusion then rtk load from directories, nothing auto-discovered beside them", async () => {
  const root = new URL("../", import.meta.url).pathname;
  const ids = [];
  for (const entry of repoConfig().plugin ?? []) {
    const dir = path.resolve(root, entry);
    assert.ok(fs.statSync(dir).isDirectory(), `${entry} is not a directory`);
    const index = ["index.js", "index.ts"].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
    assert.ok(index, `${entry} has no index.js or index.ts`);
    ids.push((await import(index)).default.id);
  }
  assert.deepEqual(ids, ["fusion", "rtk"]);
  for (const sub of ["plugin", "plugins"]) {
    const dir = path.join(root, ".opencode", sub);
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.(m?js|ts)$/.test(f)) : [];
    assert.deepEqual(files, [], `.opencode/${sub}/ would auto-load a second copy`);
  }
});

// ------------------------------------------------------ sidekick routing

// The repo's own opencode.jsonc agent table, in the fake's config shape. Under
// v2 a model declared there beats the plugin, so routing is only real if the
// table leaves the sidekick seats alone; reading the file guards that.
function repoAgentTable() {
  const cfg = repoConfig();
  const agents = {};
  for (const [id, a] of Object.entries(cfg.agent)) {
    const i = a.model?.indexOf("/");
    agents[id] = {
      mode: a.mode,
      steps: a.steps,
      ...(a.model ? { model: { providerID: a.model.slice(0, i), id: a.model.slice(i + 1), ...(a.variant ? { variant: a.variant } : {}) } } : {}),
    };
  }
  return agents;
}

test("sidekick routing: fusion.jsonc picks scout, grunt and critic over the real agent table", async () => {
  const ref = (spec, variant) => {
    const i = spec.indexOf("/");
    return { providerID: spec.slice(0, i), id: spec.slice(i + 1), ...(variant ? { variant } : {}) };
  };
  const cases = [
    // [profile, scout+grunt, critic]
    [{}, "strata/strata-iq3", "strata/strata-iq3"],
    [{ sidekick: "strata-coder", critic: "strata" }, "strata/strata-coder", "strata/strata-coder"],
    [{ sidekick: "strata", critic: "local" }, "strata/strata-iq3", "strata/strata-iq3"],
    [{ sidekick: "local", critic: "local" }, "llamacpp/fusion-sidekick", "llamacpp/fusion-sidekick-deep"],
    [{ sidekick: "local", critic: "strata" }, "llamacpp/fusion-sidekick", "strata/strata-iq3"],
    [{ sidekick: "glm", critic: "local" }, "merge-gateway/zai/glm-5.3-flash", "merge-gateway/zai/glm-5.3-flash"],
    [{ sidekick: "strata", critic: "lead" }, "strata/strata-iq3", ["merge-gateway/zai/glm-5.3", "low"]],
  ];
  for (const [profile, side, critic] of cases) {
    const h = fakeCtx(makeDir(profile, defaultOpencodeCfg), { cfgAgents: repoAgentTable() });
    await fusion.setup(h.ctx);
    h.rebuild();
    const label = JSON.stringify(profile);
    assert.deepEqual(h.agents.get("scout").model, ref(side), label);
    assert.deepEqual(h.agents.get("grunt").model, ref(side), label);
    assert.deepEqual(h.agents.get("critic").model, Array.isArray(critic) ? ref(...critic) : ref(critic), label);
  }

  // Local seats carry the panel's per-agent effort; a remote seat carries none.
  const h = fakeCtx(makeDir({ sidekick: "strata", critic: "flash" }, defaultOpencodeCfg), { cfgAgents: repoAgentTable() });
  await fusion.setup(h.ctx);
  h.rebuild();
  assert.equal(h.agents.get("scout").request.body.chat_template_kwargs.reasoning_effort, "low");
  assert.equal(h.agents.get("grunt").request.body.chat_template_kwargs.reasoning_effort, "medium");
  assert.equal(h.agents.get("critic").request.body.chat_template_kwargs, undefined);
});

test("strata requests: per-agent effort, body model kept, no residency probe or guard", async () => {
  const dir = makeDir({}, defaultOpencodeCfg);
  const h = fakeCtx(dir);
  await fusion.setup(h.ctx);
  // Any fetch here other than the slot gate's GET /slots would be a
  // /v1/models probe or a guard read: Strata has neither.
  const calls = [];
  stubFetch(async (url) => { calls.push(String(url)); throw new Error("connection refused"); });

  const model = { providerID: "strata", id: "strata-iq3" };
  const send = async (agent, extra = {}) => {
    await h.fireScoped("session:model.request", { sessionID: "s1", agent, model, baseURL: "http://127.0.0.1:8082/v1" });
    const req = new Request("http://127.0.0.1:8082/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "qwen3.8-flash-next-iq3_xxs", messages: [], ...extra }),
    });
    const ev = { sessionID: "s1", agent, model, kind: "primary", request: req };
    await h.fireScoped("session:http.request", ev);
    return JSON.parse(await ev.request.text());
  };

  const scout = await send("scout", { chat_template_kwargs: { enable_thinking: true } });
  assert.equal(scout.model, "qwen3.8-flash-next-iq3_xxs");
  assert.deepEqual(scout.chat_template_kwargs, { enable_thinking: true, reasoning_effort: "low" });
  assert.equal((await send("critic")).chat_template_kwargs.reasoning_effort, "high");
  assert.deepEqual(calls.filter((u) => !u.endsWith("/slots")), []);
});

test("tool-output compression runs on Strata when the sidekick is Strata", async () => {
  const dir = makeDir({ sidekick: "strata", compress_threshold: 5000 }, defaultOpencodeCfg);
  const h = fakeCtx(dir);
  await fusion.setup(h.ctx);
  const calls = [];
  stubFetch(async (url, init) => {
    calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(init?.body ?? "null") });
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "- 3 failures in src/a.ts" } }] }) };
  });

  const ev = toolEvent({
    tool: "read", agent: "fusion", status: "completed",
    input: { filePath: "big.log" },
    result: { content: "x".repeat(20000) },
  });
  await h.fire("tool:execute.after", ev);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:18082/v1/chat/completions");
  assert.equal(calls[0].auth, "Bearer -strata-test-key");
  assert.equal(calls[0].body.model, "strata-iq3");
  assert.match(ev.result.content, /summarized by the local model/);
  assert.match(ev.result.content, /3 failures in src\/a\.ts/);
});

// --------------------------------------------- http.request wire rewrite

test("http.request: llamacpp bodies get resident wire id and per-agent effort", async () => {
  const dir = makeDir({}, defaultOpencodeCfg);
  const h = fakeCtx(dir);
  await fusion.setup(h.ctx);
  h.rebuild();
  stubFetch(fetchOk(["resident-x"]));

  const send = async (agent) => {
    const req = new Request("http://127.0.0.1:18080/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "local", messages: [{ role: "user", content: "hi" }], temperature: 0.7 }),
    });
    const ev = { sessionID: "s1", agent, model: { providerID: "llamacpp", id: "fusion-sidekick" }, kind: "primary", request: req };
    await h.fireScoped("session:http.request", ev);
    return { ev, body: JSON.parse(await ev.request.text()) };
  };

  const grunt = await send("grunt");
  assert.equal(grunt.body.model, "resident-x");
  assert.equal(grunt.body.chat_template_kwargs.reasoning_effort, "medium");
  assert.equal(grunt.body.temperature, 0.7); // untouched; the unit owns samplers
  assert.equal(grunt.ev.request.headers.get("content-type"), "application/json");

  const critic = await send("critic");
  assert.equal(critic.body.chat_template_kwargs.reasoning_effort, "high");

  // A pre-existing chat_template_kwargs merges rather than being replaced.
  const req = new Request("http://127.0.0.1:18080/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "local", messages: [], chat_template_kwargs: { enable_thinking: true } }),
  });
  const ev = { sessionID: "s1", agent: "scout", model: { providerID: "llamacpp", id: "fusion-sidekick" }, kind: "primary", request: req };
  await h.fireScoped("session:http.request", ev);
  const body = JSON.parse(await ev.request.text());
  assert.equal(body.chat_template_kwargs.enable_thinking, true);
  assert.equal(body.chat_template_kwargs.reasoning_effort, "low");
});

test("http.request: resident model is read at request time, not from the load-time snapshot", async () => {
  // The ps stub loads "resident-x"; the live /v1/models answer says the
  // server swapped to "resident-y". The wire must carry resident-y: the
  // load-time name would evict the model that is actually loaded.
  const dir = makeDir({}, defaultOpencodeCfg);
  const h = fakeCtx(dir);
  await fusion.setup(h.ctx);
  stubFetch(fetchOk(["resident-y"]));

  const req = new Request("http://127.0.0.1:18080/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "local", messages: [] }),
  });
  const ev = { sessionID: "s1", agent: "grunt", model: { providerID: "llamacpp", id: "fusion-sidekick" }, kind: "primary", request: req };
  await h.fireScoped("session:http.request", ev);
  const body = JSON.parse(await ev.request.text());
  assert.equal(body.model, "resident-y");
});

test("http.request: a body naming a resident id is left alone; a non-resident name is refused", async () => {
  const dir = makeDir({}, defaultOpencodeCfg);
  const h = fakeCtx(dir);
  await fusion.setup(h.ctx);
  stubFetch(fetchOk(["resident-y"]));

  const send = async (model) => {
    const req = new Request("http://127.0.0.1:18080/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [] }),
    });
    const ev = { sessionID: "s1", agent: "grunt", model: { providerID: "llamacpp", id: "fusion-sidekick" }, kind: "primary", request: req };
    await h.fireScoped("session:http.request", ev);
    return JSON.parse(await ev.request.text());
  };

  assert.equal((await send("resident-y")).model, "resident-y");
});

test("http.request: no resident model or an unreadable server refuses the request", async () => {
  const dir = makeDir({}, defaultOpencodeCfg);
  const h = fakeCtx(dir);
  await fusion.setup(h.ctx);

  const send = async () => {
    const req = new Request("http://127.0.0.1:18080/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "local", messages: [] }),
    });
    const ev = { sessionID: "s1", agent: "grunt", model: { providerID: "llamacpp", id: "fusion-sidekick" }, kind: "primary", request: req };
    return h.fireScoped("session:http.request", ev);
  };

  stubFetch(fetchOk([])); // server up, nothing loaded
  await assert.rejects(send(), /no resident model/);

  stubFetch(async () => { throw new Error("connection refused"); }); // server down
  await assert.rejects(send(), /no resident model/);
});

test("http.request: a request that does not target the llama-server port is untouched", async () => {
  // The provider filter is the primary scope, but the hook also self-guards
  // by URL: a foreign request through the raw callback cannot pick up a
  // local wire id. The llamacpp hooks are called raw on purpose.
  const dir = makeDir({}, defaultOpencodeCfg);
  const h = fakeCtx(dir);
  await fusion.setup(h.ctx);
  stubFetch(fetchOk(["resident-x"]));

  const original = JSON.stringify({ model: "merge-gateway-model", messages: [{ role: "user", content: "hi" }] });
  const req = new Request("http://127.0.0.1:9999/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: original,
  });
  const ev = { sessionID: "s1", agent: "fusion", kind: "primary", request: req };
  await h.fireRegisteredFor("session:http.request", "llamacpp", ev);
  assert.equal(await ev.request.text(), original);
});

// ----------------------------------------------------------- oracle gate

test("oracle dispatch is refused in advise mode, allowed under fable", async () => {
  const dir = makeDir({ routing: "enforce", escalation: "advise" });
  const h = fakeCtx(dir);
  await fusion.setup(h.ctx);

  const ev = toolEvent({ tool: "subagent", id: "d1", agent: "fusion", input: { agent: "oracle", prompt: "hard problem" } });
  await h.fire("tool:execute.before", ev);
  assert.equal(ev.tool, "fusion_blocked");
  assert.match(ev.input.reason, /escalate/);

  const dirFable = makeDir({ routing: "enforce", escalation: "fable" });
  const hFable = fakeCtx(dirFable);
  await fusion.setup(hFable.ctx);
  const ok = toolEvent({ tool: "subagent", id: "d2", agent: "fusion", input: { agent: "oracle", prompt: "hard problem" } });
  await hFable.fire("tool:execute.before", ok);
  assert.equal(ok.tool, "subagent");
});

// -------------------------------------------------------- evidence routing

test("observe mode: stalled commands annotate output, never redirect", async () => {
  const dir = makeDir({ routing: "observe", stall_commands: 3 });
  const h = fakeCtx(dir);
  await fusion.setup(h.ctx);

  const failOnce = async (id) => {
    await h.fire("tool:execute.before", toolEvent({ tool: "shell", id, agent: "grunt", input: { command: "make check" } }));
    await h.fire("tool:execute.after", toolEvent({
      tool: "shell", id, agent: "grunt",
      status: "completed",
      result: { content: "boom: it broke", metadata: { exit: 1 } },
    }));
  };
  await failOnce("c1");
  await failOnce("c2");
  await failOnce("c3");

  // Fourth identical call: gated in observe mode -> still "shell", notice queued.
  const ev = toolEvent({ tool: "shell", id: "c4", agent: "grunt", input: { command: "make check" } });
  await h.fire("tool:execute.before", ev);
  assert.equal(ev.tool, "shell");

  const after = toolEvent({ tool: "shell", id: "c4", agent: "grunt", status: "completed", result: { content: "still broken", metadata: { exit: 1 } } });
  await h.fire("tool:execute.after", after);
  assert.match(after.result.content, /would block/);

  const kinds = controlLines(dir).map((l) => l.kind);
  assert.ok(kinds.includes("cmd-fail"));
  assert.ok(kinds.includes("cmd-stall-observed"));
});

test("enforce mode: gated call redirects to fusion_blocked, step survives", async () => {
  const dir = makeDir({ routing: "enforce", stall_commands: 3 });
  const h = fakeCtx(dir);
  await fusion.setup(h.ctx);

  for (const id of ["c1", "c2", "c3"]) {
    await h.fire("tool:execute.before", toolEvent({ tool: "shell", id, agent: "fusion", input: { command: "make check" } }));
    await h.fire("tool:execute.after", toolEvent({
      tool: "shell", id, agent: "fusion",
      status: "completed", result: { content: "nope", metadata: { exit: 2 } },
    }));
  }

  const ev = toolEvent({ tool: "shell", id: "c4", agent: "fusion", input: { command: "make check" } });
  await h.fire("tool:execute.before", ev);
  assert.equal(ev.tool, "fusion_blocked");
  assert.equal(ev.input.tool, "shell");
  assert.match(ev.input.reason, /failed 3 times/);

  // The refusal tool returns the reason as ordinary content; no throw.
  const res = await h.tools.get("fusion_blocked").execute(ev.input, {});
  assert.match(res.content, /blocked `shell`/);

  // After-hook drains the queued entry without counting it as a run or a fail.
  await h.fire("tool:execute.after", toolEvent({ tool: "fusion_blocked", id: "c4", agent: "fusion", status: "completed", input: ev.input, result: res }));
  const fails = controlLines(dir).filter((l) => l.kind === "cmd-fail");
  assert.equal(fails.length, 3);
  assert.ok(controlLines(dir).some((l) => l.kind === "cmd-stall-blocked"));
});

test("edit gate: sidekick file stall redirects, lead is never gated", async () => {
  const dir = makeDir({ routing: "enforce", stall_edits: 2 });
  const h = fakeCtx(dir);
  await fusion.setup(h.ctx);

  const edit = async (id, agent = "grunt") => {
    await h.fire("tool:execute.before", toolEvent({ tool: "edit", id, agent, input: { filePath: "src/a.ts" } }));
    await h.fire("tool:execute.after", toolEvent({ tool: "edit", id, agent, status: "completed", input: { filePath: "src/a.ts" }, result: { content: "edited" } }));
  };
  await edit("e1");
  await edit("e2");

  const ev = toolEvent({ tool: "edit", id: "e3", agent: "grunt", input: { filePath: "src/a.ts" } });
  await h.fire("tool:execute.before", ev);
  assert.equal(ev.tool, "fusion_blocked");
  assert.match(ev.input.reason, /edited .* times by grunt/);

  // The lead is never counter-gated.
  const lead = toolEvent({ tool: "edit", id: "e4", agent: "fusion", input: { filePath: "src/a.ts" } });
  await h.fire("tool:execute.before", lead);
  assert.equal(lead.tool, "edit");
});

// -------------------------------------------------------- request guard

test("model.request guard: strict refuses non-resident wire names, alias passes", async () => {
  const cfg = {
    provider: {
      llamacpp: {
        models: {
          "fusion-sidekick": { id: "local" },
          bigm: { id: "Muse-Glimmer-30B-Q3_K_L" },
        },
      },
    },
  };
  const dir = makeDir({ guard: "strict" }, cfg);
  const h = fakeCtx(dir);
  await fusion.setup(h.ctx);
  stubFetch(fetchOk(["resident-x"]));

  const event = (id) => ({
    sessionID: "s1",
    agent: "scout",
    model: { providerID: "llamacpp", id },
    kind: "primary",
    headers: {},
  });

  // An alias declaring the "local" placeholder is always allowed: the
  // http.request rewrite turns it into the resident id.
  await h.fireScoped("session:model.request", event("fusion-sidekick"));
  // A declared non-resident wire name is refused.
  await assert.rejects(
    Promise.resolve().then(() => h.fireScoped("session:model.request", event("bigm"))),
    /not resident/,
  );
  // An unmapped id is itself the wire name; a stray name is refused too.
  await assert.rejects(
    Promise.resolve().then(() => h.fireScoped("session:model.request", event("stray-model"))),
    /not resident/,
  );
});

test("model.request guard: pinned local_model that is not resident is refused", async () => {
  const dir = makeDir({ guard: "strict", local_model: "ghost-model" }, defaultOpencodeCfg);
  const h = fakeCtx(dir);
  await fusion.setup(h.ctx);
  stubFetch(fetchOk(["resident-x"]));

  const event = {
    sessionID: "s1",
    agent: "scout",
    model: { providerID: "llamacpp", id: "fusion-sidekick" },
    kind: "primary",
    headers: {},
  };
  await assert.rejects(
    Promise.resolve().then(() => h.fireScoped("session:model.request", event)),
    /pinned local_model "ghost-model" is not resident/,
  );
});

test("model.request guard: server down at load still refuses later calls", async () => {
  // Load-time ps discovery found resident-x, but if the live read cannot
  // reach the server the guard refuses rather than guessing a wire name.
  const dir = makeDir({ guard: "strict" }, defaultOpencodeCfg);
  const h = fakeCtx(dir);
  await fusion.setup(h.ctx);
  stubFetch(async () => { throw new Error("connection refused"); });

  const event = {
    sessionID: "s1",
    agent: "scout",
    model: { providerID: "llamacpp", id: "fusion-sidekick" },
    kind: "primary",
    headers: {},
  };
  await assert.rejects(
    Promise.resolve().then(() => h.fireScoped("session:model.request", event)),
    /no resident model readable/,
  );
});

test("model.request guard: warn logs and allows, off skips entirely", async () => {
  const dir = makeDir({ guard: "warn" }, defaultOpencodeCfg);
  const h = fakeCtx(dir);
  await fusion.setup(h.ctx);
  stubFetch(fetchOk(["resident-x"]));
  const event = { sessionID: "s1", agent: "scout", model: { providerID: "llamacpp", id: "stray" }, kind: "primary", headers: {} };
  await h.fireScoped("session:model.request", event); // resolves, does not reject
});

// --------------------------------------------- samplers and compaction

test("local requests lose tuned samplers; compaction injects state and orders", async () => {
  const dir = makeDir();
  const h = fakeCtx(dir);
  await fusion.setup(h.ctx);

  // Both local servers own their sampling (llama-server unit, Strata config).
  for (const model of [{ providerID: "llamacpp", id: "fusion-sidekick" }, { providerID: "strata", id: "strata-iq3" }]) {
    const ev = {
      sessionID: "s1",
      model,
      agent: "scout",
      system: [],
      messages: [],
      options: { temperature: 0.7, topP: 0.9, topK: 40, maxTokens: 100 },
    };
    await h.fireScoped("session:context", ev);
    assert.equal(ev.options.temperature, undefined, model.providerID);
    assert.equal(ev.options.topP, undefined, model.providerID);
    assert.equal(ev.options.topK, undefined, model.providerID);
    assert.equal(ev.options.maxTokens, 100, model.providerID); // untouched
  }

  // Compaction on the lead (non-llamacpp model) still injects controller state.
  const orders = { orders: { "ord-1": { status: "in_progress", seat: "chief" } } };
  fs.mkdirSync(path.join(dir, ".fusion"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".fusion", "work-orders.json"), JSON.stringify(orders));
  const comp = {
    sessionID: "s1",
    model: { providerID: "merge-gateway", id: "zai/glm-5.3" },
    agent: "fusion",
    system: [],
    messages: [],
    options: { temperature: 0.2 }, // lead samplers are not touched
    tools: {},
  };
  await h.fire("session:compaction", comp);
  assert.equal(comp.options.temperature, 0.2);
  const texts = comp.system.map((p) => p.text).join("\n");
  assert.match(texts, /fusion controller state/);
  assert.match(texts, /ord-1 \(from chief\)/);
});

// ------------------------------------------------------------ work orders

test("work_order: lead lists and claims; non-lead is refused", async () => {
  const dir = makeDir();
  const h = fakeCtx(dir);
  await fusion.setup(h.ctx);

  const brief = [
    "---", "id: fix-flake", "seat: chief", "title: Fix the flake", "---", "",
    "## Objective", "Make tests green.", "", "## Acceptance", "npm test passes", "",
  ].join("\n");
  fs.mkdirSync(path.join(dir, ".fusion", "inbox"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".fusion", "inbox", "fix-flake.md"), brief);

  const call = (args, agent) =>
    h.tools.get("work_order").execute(args, { sessionID: "s1", agent, messageID: "m", id: "t1", signal: undefined, progress: async () => {} });

  const denied = await call({ action: "list" }, "grunt");
  assert.match(denied.content, /Only the lead seat/);

  const list = await call({ action: "list" }, "fusion");
  assert.match(list.content, /fix-flake/);

  const accepted = await call({ action: "accept", id: "fix-flake" }, "fusion");
  assert.match(accepted.content, /Work order fix-flake claimed/);
  const state = JSON.parse(fs.readFileSync(path.join(dir, ".fusion", "work-orders.json"), "utf8"));
  assert.equal(state.orders["fix-flake"].status, "in_progress");

  const reported = await call({ action: "report", id: "fix-flake", status: "completed", summary: "done" }, "fusion");
  assert.match(reported.content, /Result envelope written/);
  assert.ok(fs.existsSync(path.join(dir, ".fusion", "outbox", "fix-flake.md")));
});

test("escalate advise mode writes brief and outbox envelope", async () => {
  const dir = makeDir({ escalation: "advise" });
  const h = fakeCtx(dir);
  await fusion.setup(h.ctx);

  const res = await h.tools.get("escalate").execute(
    { problem: "db deadlocks on batch insert", tried: "retried with smaller batches, same lock order", question: "which index order avoids the deadlock?", files: ["src/db.ts:42"] },
    { sessionID: "s1", agent: "fusion", messageID: "m", id: "e1", signal: undefined, progress: async () => {} },
  );
  assert.match(res.content, /handoff brief is saved/);
  assert.equal(res.metadata.route, "advise");
  assert.ok(fs.existsSync(res.metadata.file));
  const outbox = fs.readdirSync(path.join(dir, ".fusion", "outbox"));
  assert.ok(outbox.some((f) => f.startsWith("escalation-")));
});

// -------------------------------------------------------------- slot gate

// One-slot Strata keeps the prompt cache of the last request only. On
// 2026-10-09 a lead and its background grunt took turns on it, each request
// removed the other's cache, and every prompt was read again from 0. The
// gate holds the other session's request in model.request until the slot
// owner's execution ends. /slots is unreachable here, so Strata counts as
// one slot (the safe default).
const strataReq = (sessionID, agent = "fusion") => ({
  sessionID, agent, model: { providerID: "strata", id: "strata-iq3" }, baseURL: "http://127.0.0.1:8082/v1",
});
// Fire one request; report whether its model.request hook has resolved.
const track = (h, sessionID, agent) => {
  const t = { done: false };
  t.promise = h.fireScoped("session:model.request", strataReq(sessionID, agent)).then(() => { t.done = true; });
  return t;
};
const startSessions = async (h, list) => {
  for (const [sid, parentID] of list) {
    h.emit({ type: "session.created", sessionID: sid, ...(parentID ? { parentID } : {}) });
    h.emit({ type: "session.execution.started", sessionID: sid });
  }
  await settle();
};

test("slot gate: a lead's request waits while its subagent holds one-slot Strata", async () => {
  const h = fakeCtx(makeDir({}, defaultOpencodeCfg));
  await fusion.setup(h.ctx);
  await startSessions(h, [["L"], ["C", "L"]]);

  await track(h, "L").promise; // free slot: the lead goes
  await track(h, "C", "grunt").promise; // the child takes the slot from its parent
  const lead = track(h, "L");
  await settle();
  assert.equal(lead.done, false, "the lead's request must wait while its child uses the slot");

  h.emit({ type: "session.execution.succeeded", sessionID: "C" });
  await lead.promise;
});

test("slot gate: sibling subagents take turns; a waiter that ends does not keep the slot", async () => {
  const dir = makeDir({}, defaultOpencodeCfg);
  const h = fakeCtx(dir);
  await fusion.setup(h.ctx);
  await startSessions(h, [["L"], ["A", "L"], ["B", "L"], ["X"], ["Y"]]);

  await track(h, "A", "grunt").promise;
  const b = track(h, "B", "grunt");
  await settle();
  assert.equal(b.done, false, "a sibling must wait for the other sibling");
  h.emit({ type: "session.execution.succeeded", sessionID: "A" });
  await b.promise;

  // X waits for B, then the user interrupts X, and B ends at once (before
  // X's next poll). The slot must be free, not handed to X, which sends
  // nothing.
  const x = track(h, "X");
  await settle();
  assert.equal(x.done, false, "an unrelated session must wait");
  h.emit({ type: "session.execution.interrupted", sessionID: "X", reason: "user" });
  h.emit({ type: "session.execution.succeeded", sessionID: "B" });
  await settle();
  const y = track(h, "Y");
  await settle();
  assert.equal(y.done, true, "the slot must be free after its owner ends");
  await x.promise;

  const waits = controlLines(dir).filter((l) => l.kind === "slot-wait").map((l) => l.session).sort();
  assert.deepEqual(waits, ["B", "X"]);
});

test("slot gate: \"slot_gate\": false sends at once", async () => {
  const h = fakeCtx(makeDir({ slot_gate: false }, defaultOpencodeCfg));
  await fusion.setup(h.ctx);
  await startSessions(h, [["L"], ["C", "L"]]);
  await track(h, "C", "grunt").promise;
  const lead = track(h, "L");
  await settle();
  assert.equal(lead.done, true);
});

// -------------------------------------------------------------- usage log

test("step events write usage lines with agent+model attribution", async () => {
  const dir = makeDir();
  const h = fakeCtx(dir);
  await fusion.setup(h.ctx);

  h.emit({ type: "session.step.started", sessionID: "s9", assistantMessageID: "am1", agent: "grunt", model: { providerID: "llamacpp", id: "fusion-sidekick" }, started: 1 });
  h.emit({ type: "session.step.ended", sessionID: "s9", assistantMessageID: "am1", finish: "stop", cost: 0, tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } } });
  h.emit({ type: "session.usage.recorded", sessionID: "s9", source: "title", cost: 0.001, tokens: { input: 3, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } });

  for (let i = 0; i < 50 && usageLines(dir).length < 2; i++) await settle();
  const lines = usageLines(dir);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].agent, "grunt");
  assert.equal(lines[0].model, "llamacpp/fusion-sidekick");
  assert.equal(lines[0].in, 10);
  assert.equal(lines[0].out, 5);
  assert.equal(lines[0].reasoning, 2);
  assert.equal(lines[0].cache_read, 3);
  assert.equal(lines[1].agent, "title");
});

// -------------------------------------------------- shared-callID queues

test("codemode shared callID: queued pendings resolve by kind and value", async () => {
  const dir = makeDir({ routing: "observe" });
  const h = fakeCtx(dir);
  await fusion.setup(h.ctx);

  // Two inner calls sharing one callID, interleaved before their completions.
  await h.fire("tool:execute.before", toolEvent({ tool: "shell", id: "batch", agent: "grunt", input: { command: "make check" } }));
  await h.fire("tool:execute.before", toolEvent({ tool: "shell", id: "batch", agent: "grunt", input: { command: "cat x.txt" } }));

  const r1 = toolEvent({ tool: "shell", id: "batch", agent: "grunt", status: "completed", input: { command: "cat x.txt" }, result: { content: "data", metadata: { exit: 0 } } });
  await h.fire("tool:execute.after", r1);
  const r2 = toolEvent({ tool: "shell", id: "batch", agent: "grunt", status: "completed", input: { command: "make check" }, result: { content: "ok", metadata: { exit: 0 } } });
  await h.fire("tool:execute.after", r2);

  const checks = controlLines(dir).filter((l) => l.kind === "check");
  assert.equal(checks.length, 1);
  assert.equal(checks[0].cmd, "make check");
});

// ------------------------------------------------ backend health + fallback
//
// The fallback contract: a local backend that does not answer its passive
// probe reroutes sidekick seats to sidekick_fallback, emits one notice, and
// refuses retries aimed at it. When the probe starts answering again the
// seats flip back and one "back up" notice lands. The health timer is the
// trigger for the flip-back, so the test captures the interval callback
// and ticks it instead of waiting 30s.

const captureInterval = () => {
  const real = globalThis.setInterval;
  let tick = null;
  globalThis.setInterval = (cb) => {
    tick = cb;
    return { unref() {} };
  };
  return { tick: () => tick, restore: () => { globalThis.setInterval = real; } };
};

const strataDown = async (url) => {
  const u = String(url);
  if (u.includes("18082")) throw new Error("connection refused");
  return healthyBackend(url);
};

const noticeKinds = (h) => h.rpcEmitted.filter((e) => e.name === "notice").map((e) => e.data.kind);

test("backend down: strata seats reroute to sidekick_fallback, one notice, retries refused", async () => {
  stubFetch(strataDown);
  const iv = captureInterval();
  const dir = makeDir({ sidekick_fallback: "glm" }, defaultOpencodeCfg);
  const h = fakeCtx(dir, { cfgAgents: repoAgentTable() });
  await fusion.setup(h.ctx);
  h.rebuild();
  try {
    // scout/grunt/critic moved to the fallback ref.
    const fb = { providerID: "merge-gateway", id: "zai/glm-5.3-flash" };
    assert.deepEqual(h.agents.get("scout").model, fb);
    assert.deepEqual(h.agents.get("grunt").model, fb);
    assert.deepEqual(h.agents.get("critic").model, fb);

    // The down state is visible as a notice (backlog; it fired before the
    // fake RPC service existed), never silently.
    const { items } = await h.rpc("notices", {});
    const down = items.find((n) => n.kind === "backend-down");
    assert.ok(down, "no backend-down notice");
    assert.match(down.message, /Strata/);
    assert.match(down.action, /fallback/i);

    // A retry aimed at the down backend is refused.
    const retry = { model: { providerID: "strata", id: "strata-iq3" } };
    await h.fireScoped("session:retry", retry);
    assert.deepEqual(retry.decision, { retry: false });

    // Recovery: the health tick re-probes, the seats flip back, one notice.
    stubFetch(healthyBackend);
    await iv.tick()();
    await settle();
    h.rebuild();
    const ref = { providerID: "strata", id: "strata-iq3" };
    assert.deepEqual(h.agents.get("scout").model, ref);
    assert.ok(noticeKinds(h).includes("backend-up"), "no backend-up notice");
    assert.equal(noticeKinds(h).filter((k) => k === "backend-up").length, 1);
  } finally {
    iv.restore();
  }
});

test("backend down with no fallback: seats stay put and the notice says so", async () => {
  stubFetch(strataDown);
  const dir = makeDir({ sidekick_fallback: null }, defaultOpencodeCfg);
  const h = fakeCtx(dir, { cfgAgents: repoAgentTable() });
  await fusion.setup(h.ctx);
  h.rebuild();

  const ref = { providerID: "strata", id: "strata-iq3" };
  assert.deepEqual(h.agents.get("scout").model, ref);
  const { items } = await h.rpc("notices", {});
  const down = items.find((n) => n.kind === "backend-down");
  assert.ok(down);
  assert.match(down.action, /sidekick_fallback/);
});

// ------------------------------------------------------------------- RPC

test("fusion RPC: status, choices, set writes fusion.jsonc, notices drains the pending file", async () => {
  // speed and local_efforts must exist in fusion.jsonc for `set` to write
  // them: a missing key is a deliberate write-failed, not a silent add.
  const dir = makeDir(
    { sidekick: "strata", speed: "normal", local_efforts: { scout: "low" } },
    defaultOpencodeCfg,
  );
  const h = fakeCtx(dir, { cfgAgents: repoAgentTable() });
  await fusion.setup(h.ctx);

  const st = await h.rpc("status", { sessionID: "s-rpc" });
  assert.ok(st.banner);
  assert.equal(st.profile.sidekick, "strata");
  assert.equal(st.backend.strata.up, true);
  assert.equal(st.backend.llamacpp.used, false);
  assert.equal(st.session.id, "s-rpc");
  assert.ok(Array.isArray(st.dropped.audited) && Array.isArray(st.dropped.unaudited));

  const choices = await h.rpc("choices", { key: "sidekick" });
  assert.ok(choices.options.length > 0);
  assert.equal(choices.current, "strata");
  const bad = await h.rpc("choices", { key: "nonsense" });
  assert.ok(bad.error);

  // set writes the profile key and live-reloads: speed fast drops the lead
  // step budget on the next rebuild.
  const set = await h.rpc("set", { key: "speed", value: "fast" });
  assert.equal(set.applied, true);
  const profile = JSON.parse(fs.readFileSync(path.join(dir, "fusion.jsonc"), "utf8"));
  assert.equal(profile.speed, "fast");
  h.rebuild();
  assert.equal(h.agents.get("fusion").steps, 200);

  const badSet = await h.rpc("set", { key: "speed", value: "ludicrous" });
  assert.equal(badSet.__rpcError, true);
  assert.equal(badSet.type, "bad-value");

  const effortSet = await h.rpc("set", { key: "local_efforts.grunt", value: "xhigh" });
  assert.equal(effortSet.applied, true);
  const p2 = JSON.parse(fs.readFileSync(path.join(dir, "fusion.jsonc"), "utf8"));
  assert.equal(p2.local_efforts.grunt, "xhigh");

  // A notice bin/oc-server dropped on disk shows up in the backlog and the
  // file is consumed.
  fs.mkdirSync(path.join(dir, ".fusion"), { recursive: true });
  const pending = path.join(dir, ".fusion", "pending-notices.jsonl");
  fs.writeFileSync(pending, JSON.stringify({ kind: "stale-server", message: "the running server predates this checkout" }) + "\n");
  const { items } = await h.rpc("notices", {});
  assert.ok(items.some((n) => n.kind === "stale-server"));
  assert.equal(fs.readFileSync(pending, "utf8"), "");
});

// ----------------------------------------------------------------- prune

test("compaction.prune parity: the context hook shrinks stale tool outputs", async () => {
  const dir = makeDir({}, {
    ...defaultOpencodeCfg,
    compaction: { prune: true },
  });
  const h = fakeCtx(dir);
  await fusion.setup(h.ctx);

  const messages = [
    { role: "tool", content: [{ type: "tool-result", toolCallId: "a", result: { type: "text", value: "x".repeat(60000) } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "b", result: { type: "error", value: "boom" } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "c", result: { type: "text", value: "y".repeat(500) } }] },
  ];
  await h.fire("session:context", { sessionID: "s1", messages, options: {} });

  assert.match(messages[0].content[0].result.value, /\[pruned \d+ characters\]$/);
  assert.equal(messages[1].content[0].result.value, "boom");
  assert.equal(messages[2].content[0].result.value.length, 500);
});

// --------------------------------------------------------- failure notices

test("http.response notices: context 400 decoded once, other errors once each", async () => {
  const dir = makeDir({ sidekick: "local" }, defaultOpencodeCfg);
  const h = fakeCtx(dir);
  await fusion.setup(h.ctx);

  const respond = async (status, body) => {
    const res = new Response(body, { status });
    await h.fireScoped("session:http.response", {
      sessionID: "s1",
      agent: "grunt",
      model: { providerID: "llamacpp", id: "resident-x" },
      response: res,
    });
  };
  await respond(400, "request exceeds the available context size");
  await respond(400, "request exceeds the available context size");
  await respond(500, "internal error");

  const notices = h.rpcEmitted.filter((e) => e.name === "notice").map((e) => e.data);
  assert.equal(notices.filter((n) => n.kind === "context-400").length, 1, "same 400 dedupes to one notice");
  const err = notices.find((n) => n.kind === "backend-error");
  assert.ok(err);
  assert.match(err.message, /HTTP 500/);
});

test("a reply that ends on length with reasoning tokens gets a thinking-truncated notice", async () => {
  const dir = makeDir({ sidekick: "local" }, defaultOpencodeCfg);
  const h = fakeCtx(dir);
  await fusion.setup(h.ctx);

  h.emit({ type: "session.step.started", sessionID: "s7", assistantMessageID: "am9", agent: "grunt", model: { providerID: "llamacpp", id: "resident-x" } });
  h.emit({ type: "session.step.ended", sessionID: "s7", assistantMessageID: "am9", finish: "length", cost: 0, tokens: { input: 10, output: 5, reasoning: 900 } });
  for (let i = 0; i < 50 && !noticeKinds(h).length; i++) await settle();

  const n = h.rpcEmitted.find((e) => e.data?.kind === "thinking-truncated");
  assert.ok(n, "no thinking-truncated notice");
  assert.match(n.data.action, /effort/i);
});
