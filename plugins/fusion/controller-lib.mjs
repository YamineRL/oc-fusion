// Pure helpers for the evidence-routing controller in fusion.js.
// No opencode imports here so `node --test` can exercise every function.

// ------------------------------------------------------------- command keys

// The stall detector keys commands by their normalized form. Recorded from
// tool.execute.before BEFORE rtk's rewrite runs (plugin order in
// opencode.jsonc keeps fusion.js first), so the key is what the model
// actually asked for, not the compressed equivalent.
export function normalizeCommand(cmd) {
  return String(cmd ?? "").trim().replace(/\s+/g, " ");
}

// A command that verifies work. A green run resets the per-file stall clock:
// editing is only "stalling" while nothing has verified it. This is a
// heuristic list; a false negative just means the counter survives a check
// the harness did not recognize, which fails safe (more blocks, not fewer).
const VERIFICATION =
  /\b(?:npm|pnpm|yarn|bun|deno|cargo|go|mvn|gradle|make|just|cmake|pytest|vitest|jest|tsc|mypy|ruff|golangci-lint|shellcheck)\b[^|;&]*\b(?:test|tests|typecheck|type-check|lint|check|build|vet|clippy|verify|spec)\b|\b(?:pytest|vitest|jest|tsc|mypy|ruff|shellcheck|go\s+test|cargo\s+(?:test|check|clippy)|graft\s+check)\b/;

export function isVerificationCommand(cmd) {
  return VERIFICATION.test(normalizeCommand(cmd));
}

// ------------------------------------------------------------------- files

// Edit-family tools name their target differently. Covers opencode's edit,
// write, patch and multiedit shapes.
export function extractFilePath(tool, args) {
  const t = String(tool ?? "").toLowerCase();
  if (!/(edit|write|patch)/.test(t)) return null;
  if (!args || typeof args !== "object") return null;
  const p = args.filePath ?? args.file_path ?? args.path ?? args.file;
  return typeof p === "string" && p ? p : null;
}

// ------------------------------------------------------------- stall state
//
// The controller keeps two counters per project, persisted to
// .fusion/control.jsonl and held in memory for the life of the plugin:
//
//   fileEdits:  rel -> { n, by: Map<agent, n> }   edits since last green check
//   cmdFails:   cmd -> { n, sig, ts }             consecutive failures
//
// A green verification command resets fileEdits (progress was verified) and
// clears the succeeded command's own failure counter.

export function makeControllerState() {
  return {
    fileEdits: new Map(),
    cmdFails: new Map(),
    // callID -> {cmd|file} captured in before-hook, consumed in after-hook
    pending: new Map(),
    // callID -> notice text appended to that call's output in after-hook
    notices: new Map(),
    // diff-level blast radius latch; set by graft blast, cleared by green check
    scope: { exceeded: false, impacted: 0, files: [] },
    filesTouched: new Set(),
    checks: [], // last N verification results: {cmd, exit, ts}
  };
}

export function recordEdit(state, rel, agent) {
  const e = state.fileEdits.get(rel) ?? { n: 0, by: new Map() };
  e.n += 1;
  e.by.set(agent, (e.by.get(agent) ?? 0) + 1);
  state.fileEdits.set(rel, e);
  state.filesTouched.add(rel);
  return e;
}

export function recordCommandResult(state, cmd, ok, sig) {
  if (ok) {
    state.cmdFails.delete(cmd);
    return null;
  }
  const f = state.cmdFails.get(cmd) ?? { n: 0, sig: null, ts: 0 };
  f.n += 1;
  f.sig = sig;
  f.ts = Date.now();
  state.cmdFails.set(cmd, f);
  return f;
}

// A passing check is verification progress: the per-file stall clocks reset,
// and an exceeded diff scope unlatches (the big change is at least green).
export function recordVerification(state, cmd, exit) {
  const entry = { cmd, exit, ts: Date.now() };
  state.checks.push(entry);
  if (state.checks.length > 20) state.checks.shift();
  if (exit === 0) {
    state.fileEdits.clear();
    state.scope.exceeded = false;
    state.scope.impacted = 0;
    state.scope.files = [];
  }
  return entry;
}

// Short failure fingerprint: exit code plus the first non-empty output line.
// rtk may have compressed the output by now; the first line is still the most
// stable token of "how it failed".
export function failSignature(output, exit, timeout) {
  if (timeout) return "timeout";
  const first = String(output ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  const head = first ? first.slice(0, 140) : "no output";
  return `exit ${exit ?? "?"}: ${head}`;
}

// ------------------------------------------------------------------- gates
//
// Decisions the runtime makes from the counters. Each returns null (allow) or
// a reason string. The caller decides observe-vs-enforce; the pure function
// never throws so it is trivially testable.

export function gateCommand(state, cmd, maxFails) {
  const f = state.cmdFails.get(cmd);
  if (!f || f.n < maxFails) return null;
  return (
    `command failed ${f.n} times consecutively (last: ${f.sig}). ` +
    `Identical retries are blocked: change the approach or call escalate with ` +
    `what the failures ruled out.`
  );
}

export function gateEdit(state, rel, agent, opts) {
  const { stallEdits, protectedPaths, scopeLimit } = opts;
  // The lead tier is never edit-gated: counters and protected surfaces route
  // work UP to it, and its own upward route is escalation, not a block.
  if (agent === "fusion" || agent === "oracle") return null;
  for (const p of protectedPaths ?? []) {
    if (rel === p || rel.startsWith(p.endsWith("/") ? p : p + "/")) {
      return `path "${rel}" is protected (protected_paths); sidekick seats may not edit it. Route through the lead with owner approval.`;
    }
  }
  if (state.scope.exceeded) {
    return (
      `diff blast radius is ${state.scope.impacted} impacted files (limit ${scopeLimit}) ` +
      `- beyond the sidekick tier. The lead takes the remaining edits, or narrow the scope.`
    );
  }
  const e = state.fileEdits.get(rel);
  if (e && (e.by.get(agent) ?? 0) >= stallEdits) {
    return (
      `"${rel}" has been edited ${e.by.get(agent)} times by ${agent} without a green ` +
      `verification run - a measured stall. This file moves to the lead; ` +
      `do not retry the same edit.`
    );
  }
  return null;
}

// ------------------------------------------------------------- work orders

// Seats and harness exchange one artifact: a markdown file with a small
// frontmatter. Seats write .fusion/inbox/<id>.md; the lead accepts and
// reports to .fusion/outbox/<id>.md. Validation is deliberately shallow:
// frontmatter keys plus two required sections.

export function parseFrontmatter(text) {
  const m = String(text ?? "").match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    meta[kv[1]] = v;
  }
  return { meta, body: m[2] };
}

export function validateWorkOrder(text) {
  const errors = [];
  const parsed = parseFrontmatter(text);
  if (!parsed) {
    return { ok: false, errors: ["missing frontmatter block (--- … ---)"], meta: {} };
  }
  const { meta, body } = parsed;
  if (!meta.id || !/^[\w][\w.-]*$/.test(meta.id)) {
    errors.push('frontmatter needs "id: <slug>" (letters, digits, -, _, .)');
  }
  if (!meta.seat) errors.push('frontmatter needs "seat: <originating seat>"');
  if (!/^#{1,3}\s+.*objective/im.test(body)) errors.push('body needs an "## Objective" section');
  if (!/^#{1,3}\s+.*acceptance/im.test(body)) errors.push('body needs an "## Acceptance" section (the checks that make it done)');
  return { ok: errors.length === 0, errors, meta };
}

export function renderResultEnvelope({ id, status, summary, files, checks, stalls, seat, session, leadModel, note }) {
  return [
    "---",
    `id: ${id}`,
    `status: ${status}`,
    ...(seat ? [`seat: ${seat}`] : []),
    `ts: ${new Date().toISOString()}`,
    `session: ${session ?? "unknown"}`,
    `lead: ${leadModel ?? "unknown"}`,
    "---",
    "",
    `# Result: ${id}`,
    "",
    `**Status:** ${status}`,
    "",
    "## Summary",
    (summary ?? "").trim() || "(none)",
    "",
    "## Files touched",
    ...(files?.length ? files.map((f) => `- ${f}`) : ["- (none recorded)"]),
    "",
    "## Checks",
    ...(checks?.length
      ? checks.map((c) => `- \`${c.cmd}\` -> exit ${c.exit}`)
      : ["- (no verification commands recorded)"]),
    "",
    "## Routing evidence",
    ...(stalls?.length ? stalls.map((s) => `- ${s}`) : ["- none"]),
    "",
    ...(note ? ["## Needs", note.trim(), ""] : []),
  ].join("\n");
}

// A compact rendering of live controller state, injected into the compaction
// context so the retry budget survives context pruning. This is the piece
// that makes "two honest attempts" durable: the counts live on disk and in
// plugin memory, not in the lead's scrollback.
export function renderControllerState(state, limits) {
  const lines = ["[fusion controller state - survives compaction]"];
  const stalls = [];
  for (const [cmd, f] of state.cmdFails) {
    if (f.n > 0) stalls.push(`command failed ${f.n}x: \`${cmd}\` (last: ${f.sig})${f.n >= limits.stallCommands ? " - identical retries BLOCKED" : ""}`);
  }
  for (const [rel, e] of state.fileEdits) {
    const top = [...e.by.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] >= limits.stallEdits && top[0] !== "fusion") {
      stalls.push(`"${rel}" edited ${top[1]}x by ${top[0]} without a green check - sidekick is gated off this file; the lead owns it`);
    }
  }
  if (state.scope.exceeded) {
    stalls.push(`diff blast radius ${state.scope.impacted} files exceeds the sidekick limit ${limits.scopeLimit} - remaining edits go through the lead`);
  }
  const lastCheck = state.checks[state.checks.length - 1];
  lines.push(`- verification: ${lastCheck ? `last check \`${lastCheck.cmd}\` exited ${lastCheck.exit}` : "no verification command run yet"}`);
  if (stalls.length) {
    lines.push("- stalls/limits:", ...stalls.map((s) => `  - ${s}`));
  } else {
    lines.push("- no stalls or limits active");
  }
  if (state.filesTouched.size) {
    lines.push(`- files touched this run: ${[...state.filesTouched].slice(0, 20).join(", ")}${state.filesTouched.size > 20 ? ` (+${state.filesTouched.size - 20} more)` : ""}`);
  }
  return lines.join("\n");
}
