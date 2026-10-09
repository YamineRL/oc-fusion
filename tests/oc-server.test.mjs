// Contract tests for bin/oc-server.
//
// The script is the launch-time guard: a stale background server must
// restart only when idle, must never be killed while a session runs on
// it, and must report missing harness plugins in a way a TUI user can
// see. The seams are the ones the script itself reads: XDG_STATE_HOME
// for service.json, a real `sleep` process standing in for the server
// (its /proc environ and ps lstart are genuine), a stub HTTP server for
// /api/session/active and /api/plugin, and a stub `opencode` on PATH so
// `service restart` is observable without running it. The stub runs as
// its own process: the test's spawnSync would starve an in-process one.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const OC_SERVER = path.resolve(import.meta.dirname, "../bin/oc-server");

const STUB_SERVER = `
import http from "node:http";
import fs from "node:fs";
const sessions = JSON.parse(process.env.STUB_SESSIONS ?? "{}");
const plugins = JSON.parse(process.env.STUB_PLUGINS ?? "[]");
const portFile = process.env.STUB_PORT_FILE;
http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const body = JSON.stringify(
    u.pathname === "/api/session/active" ? { data: sessions }
    : u.pathname === "/api/plugin" ? { data: plugins }
    : { data: null },
  );
  res.writeHead(200, { "content-type": "application/json" }).end(body);
}).listen(0, "127.0.0.1", function () {
  fs.writeFileSync(portFile, String(this.address().port));
});
`;

// A stub "background server": one sleep process (pid and start time are
// real, environ controllable) plus a detached HTTP stub.
async function makeServer(root, { sessions = {}, plugins = [], env = {} } = {}) {
  const stubJs = path.join(root, "stub-server.mjs");
  const portFile = path.join(root, "stub-port");
  fs.writeFileSync(stubJs, STUB_SERVER);
  const proc = spawn(process.execPath, [stubJs], {
    env: {
      ...process.env,
      STUB_SESSIONS: JSON.stringify(sessions),
      STUB_PLUGINS: JSON.stringify(plugins),
      STUB_PORT_FILE: portFile,
    },
    stdio: "ignore",
  });
  const fakePid = spawn("sleep", ["300"], { env: { ...process.env, ...env } });
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const port = Number(fs.readFileSync(portFile, "utf8"));
  const stop = () => { proc.kill(); fakePid.kill(); };
  return { port, pid: fakePid.pid, stop };
}

// One isolated world per case: state dir with (optional) service.json, a
// project dir, and a PATH dir with a stub `opencode` that records
// `service restart`.
function makeWorld() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-server-"));
  const project = path.join(root, "proj");
  const bin = path.join(root, "bin");
  fs.mkdirSync(path.join(root, "state", "opencode"), { recursive: true });
  fs.mkdirSync(project);
  fs.mkdirSync(bin);
  const marker = path.join(root, "restart-called");
  fs.writeFileSync(
    path.join(bin, "opencode"),
    `#!/bin/sh\necho "$@" >> ${JSON.stringify(marker)}\n`,
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    PATH: `${bin}:${process.env.PATH}`,
    OC_SERVER_PLUGIN_WAIT: "0.3",
    OC_SERVER_TIMEOUT: "3",
    OPENCODE_CONFIG: path.join(root, "want-config.jsonc"),
  };
  fs.writeFileSync(env.OPENCODE_CONFIG, "{}");
  const writeService = (svc) =>
    fs.writeFileSync(path.join(root, "state", "opencode", "service.json"), JSON.stringify(svc));
  const run = (args) =>
    spawnSync("python3", [OC_SERVER, ...args, project], { env, encoding: "utf8" });
  return { root, project, marker, env, writeService, run };
}

const PLUGINS_OK = [
  { id: "fusion", state: { status: "active" } },
  { id: "rtk", state: { status: "active" } },
];

const pendingNotices = (project) => {
  const f = path.join(project, ".fusion", "pending-notices.jsonl");
  return fs.existsSync(f)
    ? fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l))
    : [];
};

test("ensure: stale but busy server stays up, prints standalone, queues a notice", async () => {
  const w = makeWorld();
  const srv = await makeServer(w.root, {
    sessions: { s1: { type: "running" } },
    plugins: PLUGINS_OK,
    env: { OPENCODE_CONFIG: "/definitely/other/config.jsonc" }, // env mismatch = stale
  });
  w.writeService({ url: `http://127.0.0.1:${srv.port}`, pid: srv.pid });
  try {
    const r = w.run(["ensure"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /standalone/);
    assert.ok(!fs.existsSync(w.marker), "a busy server must never be restarted");
    const notices = pendingNotices(w.project);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].kind, "stale-server");
    assert.match(notices[0].action, /private server/i);
  } finally {
    srv.stop();
  }
});

test("ensure: stale and idle restarts the server, then verifies plugins", async () => {
  const w = makeWorld();
  const srv = await makeServer(w.root, {
    sessions: {},
    plugins: PLUGINS_OK,
    env: { OPENCODE_CONFIG: "/definitely/other/config.jsonc" },
  });
  w.writeService({ url: `http://127.0.0.1:${srv.port}`, pid: srv.pid });
  try {
    const r = w.run(["ensure"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /restarting the idle background server/);
    assert.match(fs.readFileSync(w.marker, "utf8"), /service restart/);
    // The restart stub does not rotate service.json, so the same stub is
    // re-checked; its plugins are active, so no pending notice lands.
    assert.equal(pendingNotices(w.project).length, 0);
    assert.doesNotMatch(r.stdout, /standalone/);
  } finally {
    srv.stop();
  }
});

test("ensure: a fresh server with active plugins stays quiet", async () => {
  const w = makeWorld();
  // The fake server carries the harness config path and the watched files
  // predate its start: nothing is stale.
  const srv = await makeServer(w.root, {
    sessions: {},
    plugins: PLUGINS_OK,
    env: { OPENCODE_CONFIG: w.env.OPENCODE_CONFIG },
  });
  w.writeService({ url: `http://127.0.0.1:${srv.port}`, pid: srv.pid });
  try {
    const r = w.run(["ensure"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "");
    assert.doesNotMatch(r.stderr, /stale|WARNING/i);
    assert.ok(!fs.existsSync(w.marker));
  } finally {
    srv.stop();
  }
});

test("ensure: missing harness plugins warn on stderr and queue an error notice", async () => {
  const w = makeWorld();
  const srv = await makeServer(w.root, {
    sessions: {},
    plugins: [{ id: "fusion", state: { status: "failed", error: "boom" } }],
    env: { OPENCODE_CONFIG: w.env.OPENCODE_CONFIG },
  });
  w.writeService({ url: `http://127.0.0.1:${srv.port}`, pid: srv.pid });
  try {
    const r = w.run(["ensure"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /harness plugins not active/i);
    const n = pendingNotices(w.project).find((x) => x.kind === "plugin-inactive");
    assert.ok(n, "no plugin-inactive notice queued for the TUI");
    assert.equal(n.severity, "error");
    assert.match(n.message, /fusion: failed|rtk: not loaded/);
  } finally {
    srv.stop();
  }
});

test("ensure: no service.json means opencode will start a fresh server; nothing to do", () => {
  const w = makeWorld();
  const r = w.run(["ensure"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "");
  assert.equal(pendingNotices(w.project).length, 0);
});
