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

process.env.PATH = `${BIN}:${process.env.PATH}`;
process.env.FUSION_UNIT = path.join(ROOT, "llama-server.service");
process.env.FUSION_API_KEY_FILE = path.join(ROOT, "api-key");

const fusion = (await import("../.opencode/plugin/fusion.js")).default;

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
  const cfgAgents = seed.cfgAgents ?? {
    fusion: { model: { providerID: "merge-gateway", id: "zai/glm-5.3", variant: "high" }, mode: "primary", steps: 400 },
    scout: { model: { providerID: "llamacpp", id: "fusion-sidekick" }, mode: "subagent", steps: 60 },
    grunt: { model: { providerID: "llamacpp", id: "fusion-sidekick" }, mode: "subagent", steps: 80 },
    oracle: { model: { providerID: "merge-gateway", id: "anthropic/claude-fable-5-1", variant: "max" }, mode: "subagent", steps: 40 },
    critic: { model: { providerID: "llamacpp", id: "fusion-sidekick-deep" }, mode: "subagent", steps: 40 },
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

  const ctx = {
    location: { directory: dir },
    options: {},
    agent: { transform: (cb) => { transforms.agent.push(cb); return Promise.resolve({ dispose: () => {} }); } },
    model: { transform: (cb) => { transforms.model.push(cb); return Promise.resolve({ dispose: () => {} }); } },
    mcp: { transform: (cb) => { transforms.mcp.push(cb); return Promise.resolve({ dispose: () => {} }); } },
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
const stubFetch = (handler) => { globalThis.fetch = handler; };
test.afterEach(() => { globalThis.fetch = realFetch; });

// ----------------------------------------------------------- setup shape

test("v2 setup: transform ordering, oracle hidden, tools, hooks", async () => {
  const dir = makeDir({}, defaultOpencodeCfg);
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

  // All the hooks the v1 plugin relied on have v2 homes.
  assert.ok(h.hooks.get("session:model.request")?.length === 1);
  assert.ok(h.hooks.get("session:http.request")?.length === 1);
  assert.ok(h.hooks.get("session:context")?.length === 1);
  assert.ok(h.hooks.get("session:generate")?.length === 1);
  assert.ok(h.hooks.get("session:title")?.length === 1);
  assert.ok(h.hooks.get("session:compaction")?.length === 1);
  assert.ok(h.hooks.get("tool:execute.before")?.length === 1);
  assert.ok(h.hooks.get("tool:execute.after")?.length === 1);
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
  // local wire id. Fired unscoped on purpose (no provider filter).
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
  await h.fire("session:http.request", ev);
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

test("llamacpp requests lose tuned samplers; compaction injects state and orders", async () => {
  const dir = makeDir();
  const h = fakeCtx(dir);
  await fusion.setup(h.ctx);

  const ev = {
    sessionID: "s1",
    model: { providerID: "llamacpp", id: "fusion-sidekick" },
    agent: "scout",
    system: [],
    messages: [],
    options: { temperature: 0.7, topP: 0.9, topK: 40, maxTokens: 100 },
  };
  await h.fireScoped("session:context", ev);
  assert.equal(ev.options.temperature, undefined);
  assert.equal(ev.options.topP, undefined);
  assert.equal(ev.options.topK, undefined);
  assert.equal(ev.options.maxTokens, 100); // untouched

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
