import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCommand,
  isVerificationCommand,
  extractFilePath,
  makeControllerState,
  recordEdit,
  recordCommandResult,
  recordVerification,
  failSignature,
  gateCommand,
  gateEdit,
  parseFrontmatter,
  validateWorkOrder,
  renderResultEnvelope,
  renderControllerState,
} from "../.opencode/plugin/controller-lib.mjs";

test("normalizeCommand collapses whitespace", () => {
  assert.equal(normalizeCommand("  npm   test \n --watch  "), "npm test --watch");
  assert.equal(normalizeCommand(null), "");
  assert.equal(normalizeCommand(undefined), "");
});

test("isVerificationCommand catches check-shaped commands only", () => {
  for (const ok of [
    "npm test", "npm run typecheck", "pnpm lint", "cargo test",
    "go test ./...", "pytest -x", "npx tsc --noEmit", "make check",
    "npm run build", "graft check", "vitest run",
  ]) assert.ok(isVerificationCommand(ok), ok);
  for (const no of [
    "git status", "ls -la", "cat package.json", "npm install", "rm -rf x",
  ]) assert.ok(!isVerificationCommand(no), no);
});

test("extractFilePath covers edit-family tools and ignores others", () => {
  assert.equal(extractFilePath("edit", { filePath: "a.ts" }), "a.ts");
  assert.equal(extractFilePath("write", { path: "b.ts" }), "b.ts");
  assert.equal(extractFilePath("multiedit", { file_path: "c.ts" }), "c.ts");
  assert.equal(extractFilePath("read", { filePath: "a.ts" }), null);
  assert.equal(extractFilePath("bash", { command: "x" }), null);
  assert.equal(extractFilePath("edit", {}), null);
});

test("command stall: blocks the identical retry at the limit, resets on success", () => {
  const s = makeControllerState();
  const cmd = "npm test";
  recordCommandResult(s, cmd, false, "exit 1: boom");
  recordCommandResult(s, cmd, false, "exit 1: boom");
  assert.equal(gateCommand(s, cmd, 3), null); // 2 < 3: still allowed
  recordCommandResult(s, cmd, false, "exit 1: boom");
  assert.match(gateCommand(s, cmd, 3), /failed 3 times/);
  // a different command is a different key: not blocked
  assert.equal(gateCommand(s, "npm test -- --filter x", 3), null);
  // success clears the counter
  recordCommandResult(s, cmd, true);
  assert.equal(gateCommand(s, cmd, 3), null);
});

test("file stall: sidekick gated at limit, lead never counter-gated", () => {
  const s = makeControllerState();
  const opts = { stallEdits: 3, protectedPaths: [], scopeLimit: 8 };
  recordEdit(s, "src/a.ts", "grunt");
  recordEdit(s, "src/a.ts", "grunt");
  assert.equal(gateEdit(s, "src/a.ts", "grunt", opts), null);
  recordEdit(s, "src/a.ts", "grunt");
  assert.match(gateEdit(s, "src/a.ts", "grunt", opts), /moves to the lead/);
  // the lead is not counter-gated; escalation is its upward route
  assert.equal(gateEdit(s, "src/a.ts", "fusion", opts), null);
  // another sidekick on the same file is under its own counter
  assert.equal(gateEdit(s, "src/a.ts", "scout", opts), null);
});

test("green verification resets edit stalls and the scope latch", () => {
  const s = makeControllerState();
  const opts = { stallEdits: 2, protectedPaths: [], scopeLimit: 8 };
  recordEdit(s, "src/a.ts", "grunt");
  recordEdit(s, "src/a.ts", "grunt");
  s.scope.exceeded = true;
  s.scope.impacted = 12;
  assert.ok(gateEdit(s, "src/a.ts", "grunt", opts));
  recordVerification(s, "npm test", 0);
  assert.equal(gateEdit(s, "src/a.ts", "grunt", opts), null);
  assert.equal(s.scope.exceeded, false);
  assert.equal(s.checks.at(-1).exit, 0);
});

test("scope latch gates every sidekick once tripped", () => {
  const s = makeControllerState();
  const opts = { stallEdits: 3, protectedPaths: [], scopeLimit: 8 };
  s.scope.exceeded = true;
  s.scope.impacted = 20;
  assert.match(gateEdit(s, "src/new.ts", "grunt", opts), /blast radius is 20/);
  assert.equal(gateEdit(s, "src/new.ts", "fusion", opts), null);
});

test("protected paths gate sidekicks, not the lead", () => {
  const s = makeControllerState();
  const opts = { stallEdits: 3, protectedPaths: ["db/migrations/"], scopeLimit: 8 };
  assert.match(gateEdit(s, "db/migrations/0042_x.sql", "grunt", opts), /protected/);
  assert.equal(gateEdit(s, "db/other.ts", "grunt", opts), null);
  assert.equal(gateEdit(s, "db/migrations/0042_x.sql", "fusion", opts), null);
});

test("failSignature prefers timeout, else exit + first non-empty line", () => {
  assert.equal(failSignature("out", 1, true), "timeout");
  assert.equal(failSignature("\n\nError: nope\nmore", 2, false), "exit 2: Error: nope");
  assert.equal(failSignature("", 127, false), "exit 127: no output");
});

const GOOD_ORDER = `---
id: fix-seat-lock
seat: engineering-lead
title: Fix the seat lock
---

## Objective
Make the seat lock hold under concurrent bookings.

## Acceptance
npm test green, including tests/seat-holds.test.ts.
`;

test("work-order validation accepts the contract and rejects holes", () => {
  assert.equal(validateWorkOrder(GOOD_ORDER).ok, true);
  for (const bad of [
    "no frontmatter at all",
    GOOD_ORDER.replace("seat: engineering-lead\n", ""),
    GOOD_ORDER.replace("id: fix-seat-lock\n", ""),
    GOOD_ORDER.replace("## Acceptance", "## Done"),
    GOOD_ORDER.replace("## Objective", "## Goal"),
  ]) {
    const v = validateWorkOrder(bad);
    assert.equal(v.ok, false, bad.slice(0, 40));
    assert.ok(v.errors.length > 0);
  }
});

test("parseFrontmatter reads simple key: value pairs", () => {
  const p = parseFrontmatter(GOOD_ORDER);
  assert.equal(p.meta.id, "fix-seat-lock");
  assert.equal(p.meta.seat, "engineering-lead");
  assert.match(p.body, /## Objective/);
  assert.equal(parseFrontmatter("no fm"), null);
});

test("result envelope carries status, files, checks, stalls", () => {
  const out = renderResultEnvelope({
    id: "x", status: "blocked", seat: "engineering-lead", session: "s1",
    leadModel: "m", summary: "tried", note: "which lock?",
    files: ["a.ts"], checks: [{ cmd: "npm test", exit: 1 }],
    stalls: ["command failed 3x: `npm test`"],
  });
  assert.match(out, /^---\n/);
  assert.match(out, /status: blocked/);
  assert.match(out, /- a\.ts/);
  assert.match(out, /`npm test` -> exit 1/);
  assert.match(out, /## Needs/);
});

test("controller state renders compactly for compaction injection", () => {
  const s = makeControllerState();
  const limits = { stallEdits: 3, stallCommands: 3, scopeLimit: 8 };
  let txt = renderControllerState(s, limits);
  assert.match(txt, /no stalls or limits active/);
  recordCommandResult(s, "npm test", false, "exit 1: boom");
  recordCommandResult(s, "npm test", false, "exit 1: boom");
  recordCommandResult(s, "npm test", false, "exit 1: boom");
  recordEdit(s, "src/a.ts", "grunt");
  recordEdit(s, "src/a.ts", "grunt");
  recordEdit(s, "src/a.ts", "grunt");
  txt = renderControllerState(s, limits);
  assert.match(txt, /BLOCKED/);
  assert.match(txt, /lead owns it/);
});
