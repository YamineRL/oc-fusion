// Contract tests for the OpenCode v2 plugin shape of rtk.ts.
//
// The plugin is a Bash-output compressor: it rewrites `input.command` in the
// execute.before hook when rtk is available, and passes through untouched
// when it is not. `which`/`rtk` are stubbed through PATH so both branches are
// deterministic on a box where the real rtk is installed.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "rtk-v2-"));

// Load through Node's TS loader the way the v2 runtime does.
process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} --experimental-strip-types`;

const mod = await import("../.opencode/plugin/rtk.ts").catch(() => import("../.opencode/plugin/rtk.ts"));

function fakeCtx(dir) {
  const hooks = new Map();
  const tools = new Map();
  const hook = (name) => (cb, opts) => {
    const list = hooks.get(name) ?? [];
    list.push({ cb, opts });
    hooks.set(name, list);
    return Promise.resolve({ dispose: () => {} });
  };
  const ctx = {
    location: { directory: dir },
    agent: { transform: async () => ({ dispose() {} }) },
    model: { transform: async () => ({ dispose() {} }) },
    mcp: { transform: async () => ({ dispose() {} }) },
    tool: {
      transform: async () => ({ dispose() {} }),
      list: async () => [],
      hook: (name, cb) => hook(`tool:${name}`)(cb),
    },
    session: { hook: (name, cb, opts) => hook(`session:${name}`)(cb, opts) },
    permission: { hook: (n, cb) => hook(`permission:${n}`)(cb), list: async () => [] },
    event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
  };
  return {
    ctx,
    hooks,
    tools,
    fire: async (name, event) => {
      for (const { cb } of hooks.get(name) ?? []) await cb(event);
    },
  };
}

// The real rtk 0.51.0 exits 3 with the rewritten command on stdout.
function stubRtk(exitCode = 3, out = "rtk rewritten output") {
  const dir = fs.mkdtempSync(path.join(ROOT, "rtkbin-"));
  fs.writeFileSync(
    path.join(dir, "rtk"),
    `#!/bin/sh\nprintf "%s" "${out}"\nexit ${exitCode}\n`,
    { mode: 0o755 },
  );
  return dir;
}

function stubNoRtk() {
  const dir = fs.mkdtempSync(path.join(ROOT, "nortk-"));
  fs.writeFileSync(path.join(dir, "which"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  return dir;
}

const originalPath = process.env.PATH;
test.afterEach(() => { process.env.PATH = originalPath; });

const toolEvent = (tool, command) => ({
  sessionID: "s1",
  agent: "fusion",
  messageID: "m",
  id: "c1",
  tool,
  input: { command },
});

test("v2 setup: shell commands are rewritten when rtk resolves", async () => {
  process.env.PATH = `${stubRtk()}:${originalPath}`;
  const h = fakeCtx("/tmp");
  await mod.default.setup(h.ctx);

  assert.ok((h.hooks.get("tool:execute.before") ?? []).length === 1);

  const ev = toolEvent("shell", "git status");
  await h.fire("tool:execute.before", ev);
  assert.equal(ev.input.command, "rtk rewritten output");
});

test("v2 setup: non-shell tools and missing rtk pass through untouched", async () => {
  process.env.PATH = `${stubRtk()}:${originalPath}`;
  const h = fakeCtx("/tmp");
  await mod.default.setup(h.ctx);

  const ev = toolEvent("edit", "should never be rewritten");
  await h.fire("tool:execute.before", ev);
  assert.equal(ev.input.command, "should never be rewritten");
});

test("v2 setup: no rtk binary disables the plugin quietly", async () => {
  process.env.PATH = `${stubNoRtk()}`;
  const h = fakeCtx("/tmp");
  await mod.default.setup(h.ctx);
  assert.equal((h.hooks.get("tool:execute.before") ?? []).length, 0);
});

test("v2 setup: rewrite failure keeps the original command", async () => {
  process.env.PATH = `${stubRtk(1, "")}:${originalPath}`;
  const h = fakeCtx("/tmp");
  await mod.default.setup(h.ctx);

  const ev = toolEvent("shell", "make check");
  await h.fire("tool:execute.before", ev);
  assert.equal(ev.input.command, "make check");
});
