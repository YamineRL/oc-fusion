// Contract test for bin/oc-turns: it reads the opencode v2 session API
// (cursor pages, newest first) and counts failed tool calls per agent.
// The stub server speaks that API shape, including a second page, so a
// change in paging or error parsing shows here.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import http from "node:http";

const OC_TURNS = path.resolve(import.meta.dirname, "../bin/oc-turns");
const now = Date.now();
const tool = (name, status, error) => ({ type: "tool", name, state: error ? { status, error } : { status } });
const msg = (id, agent, ago, content) => ({ id, type: "assistant", agent, time: { created: now - ago * 1000 }, content });

const PAGE1 = [
  msg("m4", "scout", 10, [tool("shell", "error", { type: "permission.rejected", message: "Permission denied: shell" })]),
  msg("m3", "scout", 70, [tool("read", "completed")]),
];
const PAGE2 = [
  msg("m2", "grunt", 130, [tool("edit", "error", { type: "tool.execution", message: "Could not find oldString" })]),
  msg("m1", "grunt", 190, [tool("subagent", "error", { type: "aborted", message: "interrupted" })]),
];

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, "http://x");
      let body;
      if (u.pathname === "/api/session") {
        body = { data: [{ id: "s1", agent: "fusion", time: { updated: now }, location: { directory: "/p" } }], cursor: { next: null } };
      } else if (u.pathname === "/api/session/s1/message") {
        body = u.searchParams.get("cursor") === "two"
          ? { data: PAGE2, cursor: { next: null } }
          : { data: PAGE1, cursor: { next: "two" } };
      } else body = { data: [] };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    }).listen(0, "127.0.0.1", () => resolve(srv));
  });
}

test("counts waste per agent across pages; aborted is shown but not waste", async () => {
  const srv = await serve();
  try {
    const out = await new Promise((resolve, reject) => {
      const p = spawn("python3", [OC_TURNS, "--url", `http://127.0.0.1:${srv.address().port}`]);
      let o = "";
      p.stdout.on("data", (d) => (o += d));
      p.on("close", (code) => (code === 0 ? resolve(o) : reject(new Error(`exit ${code}: ${o}`))));
    });
    const row = (agent) => out.split("\n").find((l) => l.startsWith(agent + " ")).trim().split(/\s+/);
    // agent calls failed waste step lost
    assert.deepEqual(row("scout").slice(0, 4), ["scout", "2", "1", "1"]);
    assert.deepEqual(row("grunt").slice(0, 4), ["grunt", "2", "2", "1"]);
    assert.match(out, /grunt \/ tool.execution: edit: Could not find oldString/);
  } finally {
    srv.close();
  }
});
