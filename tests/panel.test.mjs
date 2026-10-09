// Contract tests for plugins/fusion/panel.mjs.
//
// These are the host-free pieces the /fusion TUI and the v2 plugin share:
// the panel writer that must not eat user comments, the notice store that
// dedupes across the server lifetime, the pending-file bridge from
// bin/oc-server, the dropped-key audit, the v1 prune parity helper, and
// the usage math that `oc-fusion usage` already publishes. Each test aims
// at the observable contract, not the implementation: file contents after
// a write, notice identity, pruned message shape, and totals.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  KNOBS,
  EFFORT_SEATS,
  EFFORT_LEVELS,
  writePanelKey,
  writePanelEffort,
  makeNotice,
  makeNoticeStore,
  readPendingFile,
  clearPendingFile,
  findDroppedKeys,
  pruneOldToolOutputs,
  usageTotals,
  readUsageRows,
} from "../plugins/fusion/panel.mjs";

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "fusion-panel-"));

// --------------------------------------------------------- panel write ---

test("writePanelKey replaces only the named key and keeps comments", () => {
  const dir = tmpdir();
  const file = path.join(dir, "fusion.jsonc");
  fs.writeFileSync(
    file,
    [
      "{",
      "  // The model that plans and decides.",
      '  "base": "glm",',
      '  "sidekick": "strata", // free tier',
      '  "speed": "normal"',
      "}",
    ].join("\n"),
  );

  assert.equal(writePanelKey(file, "sidekick", "glm"), true);
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /"sidekick": "glm", \/\/ free tier/);
  assert.match(text, /\/\/ The model that plans and decides\./);
  assert.match(text, /"base": "glm"/);
  // The write produced valid JSONC-content: comments aside, it parses.
  const parsed = JSON.parse(text.replace(/\/\/[^\n]*/g, ""));
  assert.equal(parsed.sidekick, "glm");
  assert.equal(parsed.speed, "normal");

  // A missing key writes nothing and reports it.
  assert.equal(writePanelKey(file, "escalation", "run"), false);
  assert.equal(fs.readFileSync(file, "utf8"), text);
});

test("writePanelEffort updates a seat and inserts a missing one", () => {
  const dir = tmpdir();
  const file = path.join(dir, "fusion.jsonc");
  fs.writeFileSync(
    file,
    JSON.stringify({ base: "glm", local_efforts: { scout: "low", grunt: "medium" } }, null, 2),
  );

  assert.equal(writePanelEffort(file, "grunt", "high"), true);
  let parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(parsed.local_efforts, { scout: "low", grunt: "high" });

  assert.equal(writePanelEffort(file, "critic", "xhigh"), true);
  parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(parsed.local_efforts, { scout: "low", grunt: "high", critic: "xhigh" });

  // No local_efforts block at all: nothing written.
  const bare = path.join(dir, "bare.jsonc");
  fs.writeFileSync(bare, '{ "base": "glm" }\n');
  assert.equal(writePanelEffort(bare, "scout", "low"), false);
});

// ------------------------------------------------------------- notices ---

test("notice store dedupes by id and lists what it queued", () => {
  const store = makeNoticeStore();
  const a = makeNotice("backend-down", "llama-server is not answering.", "Start llama-server.");
  const b = makeNotice("backend-down", "llama-server is not answering.", "Start llama-server.");
  const c = makeNotice("backend-down", "Strata is not answering.", "Start Strata.");
  assert.equal(a.id, b.id, "same kind + message dedupes to one id");
  assert.notEqual(a.id, c.id);
  assert.equal(store.offer(a), true);
  assert.equal(store.offer(b), false);
  assert.equal(store.offer(c), true);
  assert.equal(store.list().length, 2);
  assert.equal(store.drain().length, 2);
  assert.equal(store.list().length, 0);
  // Drained or not, a repeat of an already-seen notice stays refused.
  assert.equal(store.offer(a), false);
});

test("pending file bridge: jsonl in, list out, malformed lines skipped", () => {
  const dir = tmpdir();
  const file = path.join(dir, "pending-notices.jsonl");
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ kind: "stale-server", message: "server is stale", action: "restart it" }),
      '{"kind":"truncated"', // a torn write: skipped, not fatal
      "",
      JSON.stringify({ kind: "plugin-inactive", message: "fusion plugin is not active" }),
    ].join("\n"),
  );
  const items = readPendingFile(file);
  assert.equal(items.length, 2);
  assert.equal(items[0].kind, "stale-server");
  assert.ok(items[0].id, "a notice without an id gets a stable derived one");
  assert.equal(items[1].kind, "plugin-inactive");

  clearPendingFile(file);
  assert.equal(readPendingFile(file).length, 0);
  // A missing file reads as empty rather than throwing.
  assert.equal(readPendingFile(path.join(dir, "nope.jsonl")).length, 0);
});

// -------------------------------------------------------- dropped keys ---

test("dropped-key audit splits audited v1-only keys from silently dead ones", () => {
  const { audited, unaudited } = findDroppedKeys({
    experimental: { batch_tool: true, primary_tools: ["read"], unknowable_knob: 1 },
    compaction: { prune: true, tail_turns: 8 },
    subagent_depth: 3,
    provider: {
      llamacpp: {
        models: {
          "fusion-sidekick": {
            reasoning: true,
            temperature: 0.7,
            options: { chat_template_kwargs: { reasoning_effort: "medium" }, top_k: 40 },
          },
        },
      },
    },
  });
  // Audited: documented v1-only keys the plugin covers.
  for (const k of ["experimental.batch_tool", "experimental.primary_tools", "compaction.prune"]) {
    assert.ok(audited.includes(k), `expected ${k} audited`);
  }
  assert.ok(audited.includes("provider.llamacpp.models.fusion-sidekick.reasoning"));
  assert.ok(audited.includes("provider.llamacpp.models.fusion-sidekick.temperature"));
  // Unaudited: keys v2 drops with no documented reason.
  assert.ok(unaudited.includes("subagent_depth"));
  assert.ok(unaudited.includes("compaction.tail_turns"));
  // options is audited only for the keys the plugin re-injects; top_k is dead.
  assert.ok(unaudited.some((k) => k.includes("options") && k.includes("top_k")));
});

// --------------------------------------------------------------- prune ---

const toolResultMessage = (id, text, error = false) => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: id,
      result: error ? { type: "error", value: text } : { type: "text", value: text },
    },
  ],
});

test("pruneOldToolOutputs shrinks old outputs, keeps errors and the tail", () => {
  const big = (n) => "x".repeat(n);
  const messages = [
    toolResultMessage("old-1", big(20000)),
    toolResultMessage("old-err", "ENOENT: no such file", true),
    { role: "assistant", content: [{ type: "text", text: "thinking" }] },
    toolResultMessage("old-2", big(20000)),
    toolResultMessage("recent", big(9000)),
  ];

  const pruned = pruneOldToolOutputs(messages, { protectTail: 10000, maxChunk: 2000 });
  assert.equal(pruned, 2, "the two old oversized results shrink");

  const old1 = messages[0].content[0];
  assert.match(old1.result.value, /\[pruned 18000 characters\]$/);
  assert.equal(old1.result.value.length, 2000 + "\n[pruned 18000 characters]".length);

  const oldErr = messages[1].content[0];
  assert.equal(oldErr.result.type, "error", "error results never shrink");
  assert.equal(oldErr.result.value, "ENOENT: no such file");

  const old2 = messages[3].content[0];
  assert.match(old2.result.value, /\[pruned 18000 characters\]$/);

  const recent = messages[4].content[0];
  assert.equal(recent.result.value.length, 9000, "the protected tail stays whole");
});

test("pruneOldToolOutputs leaves small results and short contexts alone", () => {
  const messages = [toolResultMessage("a", "short"), toolResultMessage("b", "also short")];
  assert.equal(pruneOldToolOutputs(messages, { protectTail: 100, maxChunk: 2000 }), 0);
  assert.equal(messages[0].content[0].result.value, "short");
  // Nothing to prune on a malformed or empty list.
  assert.equal(pruneOldToolOutputs([], {}), 0);
  assert.equal(pruneOldToolOutputs([{ role: "user", content: "hi" }], {}), 0);
});

// ---------------------------------------------------------- accounting ---

test("usageTotals rolls up per agent and prices delegated tokens at lead rates", () => {
  const rows = [
    { agent: "fusion", in: 1_000_000, out: 100_000, cost: 0.92 },
    { agent: "scout", in: 500_000, out: 50_000, reasoning: 10_000, cost: 0 },
    { agent: "grunt", in: 500_000, out: 40_000, reasoning: 10_000, cost: 0 },
  ];
  const t = usageTotals(rows, "glm");
  assert.equal(t.byAgent.fusion.msgs, 1);
  assert.equal(t.byAgent.scout.output, 50_000);
  assert.equal(t.totalCost, 0.92);
  // Shadow: sidekick tokens at glm rates (0.7 in / 2.2 out per million),
  // reasoning billed as output. The lead's own tokens are not delegated.
  const shadowIn = 1_000_000;
  const shadowOut = 90_000 + 20_000;
  const want = (shadowIn * 0.7 + shadowOut * 2.2) / 1e6;
  assert.ok(Math.abs(t.shadowCost - want) < 1e-9, `${t.shadowCost} != ${want}`);
  assert.equal(t.freeLead, false);

  const free = usageTotals(rows, "union-alpha");
  assert.equal(free.shadowCost, 0);
  assert.equal(free.freeLead, true);
});

test("readUsageRows filters by session and skips torn lines", () => {
  const dir = tmpdir();
  const file = path.join(dir, "usage.jsonl");
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ session: "s1", agent: "fusion", in: 1, out: 2, cost: 0.1 }),
      '{"session":"s1"',
      JSON.stringify({ session: "s2", agent: "scout", in: 3, out: 4, cost: 0 }),
    ].join("\n"),
  );
  assert.equal(readUsageRows(file).length, 2);
  const s1 = readUsageRows(file, "s1");
  assert.equal(s1.length, 1);
  assert.equal(s1[0].agent, "fusion");
  assert.equal(readUsageRows(path.join(dir, "missing.jsonl")).length, 0);
});

// -------------------------------------------------------------- knobs ----

test("every TUI knob has a profile write target and non-empty options", () => {
  // The TUI renders KNOBS verbatim and `set` writes them: a knob that maps
  // to no profile key or no choices is a dead menu entry.
  for (const [key, knob] of Object.entries(KNOBS)) {
    assert.ok(knob.write, `${key} has no write target`);
    const options = knob.options({ glm: { model: "m" } }, { local: "x", strata: "y" });
    assert.ok(options.length > 0, `${key} has no options`);
    for (const o of options) assert.ok(o.value && o.title, `${key} option missing value/title`);
  }
  for (const seat of EFFORT_SEATS) assert.ok(typeof seat === "string");
  for (const level of EFFORT_LEVELS) assert.ok(typeof level === "string");
});
