// Fusion-style two-tier routing for opencode.
//
// Lead model does the thinking; the free local llama.cpp model absorbs the
// bulk. Knobs live in fusion.jsonc and are applied to the agent set at load.
//
// The local side is deliberately defensive: llama-server runs with
// --models-max 1, so naming a model that is not resident evicts the resident
// one mid-generation. Every local alias therefore sends the same wire id, and
// the guard below refuses (or warns about) anything else.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { tool } from "@opencode-ai/plugin";
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
} from "./controller-lib.mjs";

// Machine-specific locations, overridable. Defaults follow XDG.
const UNIT = process.env.FUSION_UNIT ?? path.join(os.homedir(), ".config/systemd/user/llama-server.service");
const API_KEY_FILE = process.env.FUSION_API_KEY_FILE ?? path.join(os.homedir(), ".config/llama-server/api-key");

// ---------------------------------------------------------------- base models

// Effort ladders come from each model's advertised reasoning_options. They
// differ per vendor: GLM exposes low/high/max, Anthropic adds medium/xhigh.
const LADDER = ["none", "low", "medium", "high", "xhigh", "max"];

const BASES = {
  // OpenCode Zen's free stealth lead. It reasons (reasoning: true) but
  // advertises no levels, so its ladder is empty: the model manages its own
  // effort and the harness must send no variant for it.
  "union-alpha": { model: "opencode/union-alpha", efforts: [], free: true },
  glm:       { model: "merge-gateway/zai/glm-5.3",              efforts: ["low", "high", "max"] },
  "glm-flash": { model: "merge-gateway/zai/glm-5.3-flash",      efforts: ["low", "high", "max"] },
  fable:     { model: "merge-gateway/anthropic/claude-fable-5-1", efforts: ["low", "medium", "high", "xhigh", "max"] },
  astra:     { model: "merge-gateway/openai/gpt-6-astra",       efforts: ["low", "medium", "high", "xhigh", "max"] },
  sol:       { model: "merge-gateway/openai/gpt-5.6-sol",       efforts: ["none", "low", "medium", "high", "xhigh", "max"] },
  opus:      { model: "merge-gateway/anthropic/claude-opus-5",  efforts: ["low", "medium", "high", "xhigh", "max"] },
};

// The gateway only publishes vendor `-fast` twins for a few older models.
// Where one exists, `speed: fast` uses it; otherwise fast just means one notch
// less reasoning and a tighter step budget. No pretending.
const FAST_TWIN = {
  "merge-gateway/anthropic/claude-opus-4-6": "merge-gateway/anthropic/claude-opus-4-6-fast",
  "merge-gateway/anthropic/claude-opus-4-7": "merge-gateway/anthropic/claude-opus-4-7-fast",
};

const SIDEKICKS = {
  local:        "llamacpp/fusion-sidekick",
  "local-fast": "llamacpp/fusion-sidekick-fast",
  "local-deep": "llamacpp/fusion-sidekick-deep",
  glm:          "merge-gateway/zai/glm-5.3-flash",
  deepseek:     "merge-gateway/deepseek/deepseek-v4-flash",
};

// The critic reviews the lead's work, so it should not be a weaker model than
// the edit it audits unless the user says so. Applied independently of the
// sidekick knob.
const CRITICS = {
  local: null, // leave the agent table's llamacpp/fusion-sidekick-deep alone
  flash: { model: "merge-gateway/zai/glm-5.3-flash", variant: "low" },
  lead:  "lead", // resolved at load: the lead's own model at low effort
};

const DEFAULTS = {
  base: "glm",
  sidekick: "local",
  speed: "normal",
  reasoning: "high",
  // Where the lead goes when it cannot crack something.
  //   advise  write a handoff brief and point at Claude Code  (no spend)
  //   run     invoke `claude -p` directly                     (subscription)
  //   fable   the paid gateway oracle subagent                (gateway balance)
  escalation: "advise",
  oracle: "fable",
  claude_model: null,
  guard: "warn",
  compress_tool_output: true,
  compress_threshold: 12000,
  critic: "local",
  // Which wire id the local aliases send. null = discover from the running
  // llama-server (its --alias, or the .gguf basename). Discovery is the
  // default because naming a model that is not resident evicts whatever is
  // loaded; set it explicitly only to pin against a future server restart.
  local_model: null,
  // reasoning_effort injected per local agent. Keys are agent names; null
  // means "do not inject for this agent". These values must be ones the
  // model's chat template accepts -- a template throws on an unknown level
  // rather than falling back, so adjust to your model.
  local_efforts: { scout: "low", grunt: "medium", critic: "high" },

  // Evidence routing. The runtime measures stalls and scope instead of asking
  // the lead to estimate hardness, and keeps the counters in plugin memory +
  // .fusion/control.jsonl so compaction cannot prune them away.
  //   observe   log and annotate, never block (calibration mode)
  //   enforce   block the call with an error the agent cannot ignore
  routing: "observe",
  // Same file edited this many times by one sidekick agent without a green
  // verification run -> that file moves to the lead.
  stall_edits: 3,
  // Same normalized command failing this many times in a row -> identical
  // retries are blocked for every agent, lead included.
  stall_commands: 3,
  // Measure blast radius with graft. Up front: skeleton+callers on the first
  // sidekick edit per file. After edits: `graft blast` on the working diff.
  // Without a graft/ index, scope is "unknown" and nothing here blocks on it.
  scope_check: true,
  // Dependent-file budget for sidekick edits. A file (or working diff) whose
  // dependents exceed this moves to the lead tier.
  grunt_max_blast: 8,
  // Repo-relative prefixes sidekick agents may never edit, whatever the
  // measurements say. Migrations, secrets-adjacent config, deploy manifests.
  protected_paths: [],
};

// ------------------------------------------------------------------- helpers

function stripJsonc(text) {
  // Good enough for this file: drop // line comments outside strings, and
  // trailing commas before } or ].
  let out = "";
  let inStr = false, esc = false, inLine = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inLine) { if (c === "\n") { inLine = false; out += c; } continue; }
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === "/" && n === "/") { inLine = true; i++; continue; }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

// The harness root, i.e. where this plugin lives, two levels up from
// .opencode/plugin/. Used so the control panel is found when opencode runs in
// some other repo rather than in the harness directory itself.
const HARNESS = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");

function readProfile(dir) {
  // In precedence order: an explicit override, the project you are working in
  // (so a repo can pin its own profile), then the harness default.
  const candidates = [
    ...(process.env.FUSION_PROFILE ? [process.env.FUSION_PROFILE] : []),
    path.join(dir, "fusion.jsonc"),
    path.join(dir, "fusion.json"),
    path.join(HARNESS, "fusion.jsonc"),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return { ...DEFAULTS, ...JSON.parse(stripJsonc(fs.readFileSync(p, "utf8"))) };
    } catch (e) {
      console.error(`[fusion] ${path.basename(p)} is not valid JSON, using defaults: ${e.message}`);
    }
  }
  return { ...DEFAULTS };
}

// Clamp a requested effort to what this model actually advertises, preferring
// the nearest level at or below the request. An empty ladder means the model
// advertises no levels at all: it manages its own effort, so the honest
// answer is "no variant".
function clampEffort(want, available) {
  if (available.length === 0) return null;
  if (available.includes(want)) return want;
  const wi = LADDER.indexOf(want);
  if (wi < 0) return available[available.length - 1];
  const ranked = available
    .map((e) => ({ e, d: LADDER.indexOf(e) - wi }))
    .sort((a, b) => (a.d <= 0) === (b.d <= 0) ? Math.abs(a.d) - Math.abs(b.d) : (a.d <= 0 ? -1 : 1));
  return ranked[0].e;
}

// One notch down, but never all the way to "none": `speed: fast` is meant to
// trade depth for latency, not to switch the lead's reasoning off.
function stepDown(effort, available) {
  if (effort == null) return null; // no ladder: the model manages its own effort
  const i = available.indexOf(effort);
  if (i <= 0) return effort;
  const next = available[i - 1];
  return next === "none" ? effort : next;
}

// ------------------------------------------- llama-server unit as source of truth

// Parse the systemd unit rather than duplicating its flags. This is the
// contract: if the unit changes, the config follows.
function readUnit() {
  const out = { ctx: null, port: null, modelsDir: null, modelsMax: null, parallel: null, effort: null, idle: null };
  // systemd merges <unit>.d/*.conf over the base unit in lexical order, and an
  // empty ExecStart= resets the list. Read the same way, or a drop-in that
  // changes the flags would be invisible here and the contract above would
  // quietly stop holding.
  const sources = [];
  try { sources.push(fs.readFileSync(UNIT, "utf8")); } catch { return out; }
  try {
    const dir = `${UNIT}.d`;
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".conf")).sort()) {
      sources.push(fs.readFileSync(`${dir}/${f}`, "utf8"));
    }
  } catch { /* no drop-ins is the normal case */ }

  // Last non-empty ExecStart across base + drop-ins is the effective one.
  let body = null;
  for (const text of sources) {
    for (const chunk of text.split(/ExecStart=/).slice(1)) {
      const b = chunk.split(/\n(?=[A-Z][A-Za-z]*=)/)[0].replace(/\\\s*\n/g, " ").trim();
      if (b) body = b;
    }
  }
  if (!body) return out;
  const grab = (re) => { const m = body.match(re); return m ? m[1] : null; };
  const num = (v) => (v == null ? null : Number(v));
  out.ctx = num(grab(/(?:-c|--ctx-size)\s+(\d+)/));
  out.port = num(grab(/--port\s+(\d+)/));
  out.modelsDir = grab(/--models-dir\s+(\S+)/);
  out.modelsMax = num(grab(/--models-max\s+(\d+)/));
  out.parallel = num(grab(/--parallel\s+(\d+)/));
  out.idle = num(grab(/--sleep-idle-seconds\s+(\d+)/));
  const ctk = grab(/--chat-template-kwargs\s+'([^']+)'/);
  if (ctk) { try { out.effort = JSON.parse(ctk).reasoning_effort ?? null; } catch {} }
  return out;
}

// Which model is actually resident, read passively from the child server's
// cmdline. Never probes an inference endpoint, so it cannot trigger a load.
async function residentModels($) {
  try {
    const txt = await $`ps -eo args=`.text();
    const found = new Map();
    for (const line of txt.split("\n")) {
      if (!/^\s*\S*llama-server\s/.test(line)) continue;
      const alias = line.match(/--alias\s+(\S+)/)?.[1];
      const model = line.match(/(?:--model|-m)\s+(\S+\.gguf)/)?.[1];
      const id = alias ?? (model ? path.basename(model, ".gguf") : null);
      if (!id) continue;
      found.set(id, {
        ctx: Number(line.match(/(?:^|\s)(?:-c|--ctx-size)\s+(\d+)/)?.[1]) || null,
        parallel: Number(line.match(/(?:^|\s)(?:-np|--parallel)\s+(\d+)/)?.[1]) || null,
      });
    }
    return found;
  } catch {
    return new Map();
  }
}

// ---------------------------------------------------------------- the plugin

export const server = async ({ directory, $ }) => {
  const profile = readProfile(directory);
  const unit = readUnit();

  const base = BASES[profile.base] ?? BASES[DEFAULTS.base];
  if (!BASES[profile.base]) {
    console.error(`[fusion] unknown base "${profile.base}", falling back to "${DEFAULTS.base}". Known: ${Object.keys(BASES).join(", ")}`);
  }
  const oracleBase = BASES[profile.oracle] ?? BASES.fable;
  const oracleEffort = clampEffort("max", oracleBase.efforts);
  const fast = profile.speed === "fast";

  let leadEffort = clampEffort(profile.reasoning, base.efforts);
  if (fast) leadEffort = stepDown(leadEffort, base.efforts);
  const leadModel = (fast && FAST_TWIN[base.model]) || base.model;

  const sidekick = SIDEKICKS[profile.sidekick] ?? SIDEKICKS.local;
  if (!SIDEKICKS[profile.sidekick]) {
    console.error(`[fusion] unknown sidekick "${profile.sidekick}", falling back to "local". Known: ${Object.keys(SIDEKICKS).join(", ")}`);
  }
  // A remote sidekick has no local slot to protect and no 44k ceiling.
  const sidekickIsLocal = sidekick.startsWith("llamacpp/");

  // Note: CRITICS.local is null (meaning "leave the agent table alone"), so
  // membership must be tested with hasOwn, not truthiness.
  const criticKnown = Object.hasOwn(CRITICS, profile.critic);
  const criticChoice = criticKnown ? CRITICS[profile.critic] : CRITICS.local;
  if (!criticKnown) {
    console.error(`[fusion] unknown critic "${profile.critic}", falling back to "local". Known: ${Object.keys(CRITICS).join(", ")}`);
  }
  const criticEffort = clampEffort("low", base.efforts);
  const criticPatch =
    criticChoice === "lead"
      ? { model: leadModel, ...(criticEffort ? { variant: criticEffort } : {}) }
      : criticChoice; // null (local) or { model, variant }

  const resident = await residentModels($);
  // The wire id every local alias sends: pinned via the panel, else whatever
  // the running server has resident. Discovery means the harness cannot ask
  // the server for a model it does not have loaded.
  const localWireId = profile.local_model ?? [...resident.keys()][0] ?? null;
  // Router presets put context flags on the child, not the systemd unit.
  const localRuntime = resident.get(localWireId);
  if (!localWireId) {
    console.error("[fusion] no local model pinned and none resident (is llama-server running?). Local agents will fail until it is up.");
  }

  // Track which agent owns a session so tool-output compression only fires
  // for the paid tiers. tool.execute.after does not carry the agent itself.
  const agentBySession = new Map();
  // Message IDs already written to the usage log this run (see event hook).
  const loggedMessages = new Set();

  // ------------------------------------------------- evidence routing
  //
  // The controller: measured stalls and measured scope pick the tier, not
  // the lead's judgment. State lives in plugin memory (survives compaction)
  // and is mirrored to .fusion/control.jsonl (survives restarts). Limits
  // come from the panel; "observe" annotates and logs, "enforce" throws in
  // tool.execute.before so the call never runs.
  const ctrl = makeControllerState();
  const fusionDir = path.join(directory, ".fusion");
  const controlLog = path.join(fusionDir, "control.jsonl");
  const ordersFile = path.join(fusionDir, "work-orders.json");
  const inboxDir = path.join(fusionDir, "inbox");
  const outboxDir = path.join(fusionDir, "outbox");

  function logControl(ev) {
    try {
      fs.mkdirSync(fusionDir, { recursive: true });
      fs.appendFileSync(controlLog, JSON.stringify({ ts: new Date().toISOString(), ...ev }) + "\n");
    } catch (e) {
      console.error(`[fusion] control log write failed: ${e.message}`);
    }
  }

  // One decision path for every gate: enforce throws (the call never runs and
  // the agent gets the reason as a tool error); observe queues a notice that
  // the after-hook appends to that call's output. Either way it is logged.
  function gate(callID, kind, reason, extra = {}) {
    logControl({ kind: profile.routing === "enforce" ? `${kind}-blocked` : `${kind}-observed`, ...extra, reason });
    if (profile.routing === "enforce") {
      throw new Error(`[fusion routing] ${reason}`);
    }
    if (ctrl.notices.size > 200) ctrl.notices.delete(ctrl.notices.keys().next().value);
    ctrl.notices.set(callID, `[fusion routing: observe] would block: ${reason}`);
  }

  // graft runs through the harness wrapper (unshare: no network for it or its
  // children, --deep refused upstream). --no-refresh on every call: measuring
  // scope must never rebuild the index mid-edit. Failures resolve to null,
  // which callers treat as "unknown" and never block on.
  const graftBin = path.join(HARNESS, "bin", "oc-fusion");
  const hasGraft = () => fs.existsSync(path.join(directory, "graft"));

  function graftJson(args, timeoutMs = 20000) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(graftBin, ["graft", ...args], { cwd: directory, stdio: ["ignore", "pipe", "pipe"] });
      } catch {
        return resolve(null);
      }
      let out = "", err = "";
      const timer = setTimeout(() => { child.kill("SIGTERM"); resolve(null); }, timeoutMs);
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { err += d; });
      child.on("error", () => { clearTimeout(timer); resolve(null); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          logControl({ kind: "graft-error", args: args.join(" "), err: err.trim().slice(0, 200) });
          return resolve(null);
        }
        try { resolve(JSON.parse(out)); } catch { resolve(null); }
      });
    });
  }

  // Up-front scope: dependents of a file's symbols, before the sidekick's
  // first edit. skeleton gives the file's symbols; callers --depth 1 gives
  // who imports/calls them. Result is unique dependent paths, cached per file.
  const fileScope = new Map(); // rel -> {deps:number|null, ts}
  async function measureFileScope(rel) {
    const sk = await graftJson(["skeleton", rel, "--json", "--no-refresh"]);
    if (!sk?.entries?.length) return null;
    const deps = new Set();
    for (const e of sk.entries.slice(0, 4)) {
      const c = await graftJson(["callers", e.name, "--json", "--no-refresh"]);
      for (const m of c?.matches ?? []) {
        for (const h of m.hits ?? []) {
          if (h.path && h.path !== rel) deps.add(h.path);
        }
      }
    }
    return deps.size;
  }

  // Post-edit scope: `graft blast` on the working diff. More honest than the
  // up-front estimate because it measures what actually changed. Latched into
  // ctrl.scope; a green verification run clears it.
  let blastChecks = 0;
  async function measureDiffScope() {
    const b = await graftJson(["blast", "--format", "json", "--no-refresh", "--depth", "2"]);
    if (!b || !Array.isArray(b.impacted)) return null;
    return { impacted: b.impacted.length, files: [...new Set(b.impacted.map((i) => i.path).filter(Boolean))] };
  }

  // ------------------------------------------------------------- work orders
  //
  // Seats (Chief of Staff, Engineering Lead, ...) and this harness exchange
  // one artifact: a markdown file with frontmatter. Inbound: a seat drops
  // .fusion/inbox/<id>.md (via `oc-fusion work submit`, which validates it).
  // Outbound: the lead reports .fusion/outbox/<id>.md through the work_order
  // tool, and `escalate` writes a needs-decision envelope the seat layer can
  // pick up. Claim state lives in work-orders.json so two sessions cannot
  // silently take the same order.
  function readOrders() {
    try {
      return JSON.parse(fs.readFileSync(ordersFile, "utf8"));
    } catch {
      return { orders: {} };
    }
  }

  function writeOrders(state) {
    try {
      fs.mkdirSync(fusionDir, { recursive: true });
      fs.writeFileSync(ordersFile, JSON.stringify(state, null, 2) + "\n");
    } catch (e) {
      console.error(`[fusion] work-orders write failed: ${e.message}`);
    }
  }

  function listInbox() {
    let files = [];
    try {
      files = fs.readdirSync(inboxDir).filter((f) => f.endsWith(".md")).sort();
    } catch {
      return [];
    }
    const claimed = readOrders().orders;
    const out = [];
    for (const f of files) {
      const text = fs.readFileSync(path.join(inboxDir, f), "utf8");
      const parsed = parseFrontmatter(text);
      const id = parsed?.meta?.id ?? path.basename(f, ".md");
      out.push({
        id,
        file: f,
        seat: parsed?.meta?.seat ?? null,
        title: parsed?.meta?.title ?? null,
        status: claimed[id]?.status ?? "pending",
        errors: validateWorkOrder(text).errors,
      });
    }
    return out;
  }

  function stallsSummary() {
    const out = [];
    for (const [cmd, f] of ctrl.cmdFails) {
      out.push(`command failed ${f.n}x consecutively: \`${cmd}\` (last: ${f.sig})`);
    }
    for (const [rel, e] of ctrl.fileEdits) {
      const top = [...e.by.entries()].sort((a, b) => b[1] - a[1])[0];
      if (top) out.push(`"${rel}" edited ${top[1]}x by ${top[0]} without a green check`);
    }
    if (ctrl.scope.exceeded) {
      out.push(`diff blast radius ${ctrl.scope.impacted} files (limit ${profile.grunt_max_blast})`);
    }
    return out;
  }


  const banner = [
    `[fusion] lead ${leadModel}${leadEffort ? ` (${leadEffort})` : ""}`,
    `sidekick ${sidekick}${sidekickIsLocal ? " [free]" : ""}`,
    `critic ${
      criticPatch
        ? `${criticPatch.model}${profile.critic === "lead" ? " (self-review)" : ""}`
        : "llamacpp/fusion-sidekick-deep [free]"
    }`,
    `escalate ${
      profile.escalation === "fable"
        ? `${oracleBase.model}${oracleEffort ? ` (${oracleEffort})` : ""}${oracleBase.free ? " [free]" : " (paid)"}`
        : profile.escalation === "run"
          ? "claude -p (subscription)"
          : "Claude Code handoff brief (no spend)"
    }`,
    `speed ${profile.speed}`,
  ].join(" | ");
  console.error(banner);
  if (fast && !FAST_TWIN[base.model]) {
    console.error(
      leadEffort
        ? `[fusion] note: the gateway publishes no -fast twin for ${base.model}; fast = one notch less reasoning + tighter step budget.`
        : `[fusion] note: ${base.model} advertises no reasoning levels, so fast = just the tighter step budget for it.`,
    );
  }
  if (unit.ctx) {
    console.error(`[fusion] llama-server unit: ctx ${unit.ctx}, parallel ${unit.parallel}, models-max ${unit.modelsMax}, idle-sleep ${unit.idle}s`);
  }
  if (sidekickIsLocal && resident.size && !resident.has(localWireId)) {
    console.error(`[fusion] WARNING: sidekick wants "${localWireId}" but resident is "${[...resident.keys()].join(", ")}". First sidekick call will evict it.`);
  }

  return {
    tool: {
      escalate: tool({
        description:
          "Hand a problem you cannot solve to Claude Code, which runs on a " +
          "subscription rather than gateway balance. Use this instead of " +
          "burning frontier tokens. Call it only after you have actually " +
          "investigated: the brief you write is the whole value of the handoff.",
        args: {
          problem: tool.schema
            .string()
            .describe("What is wrong or what must be decided. Be specific and concrete."),
          tried: tool.schema
            .string()
            .describe(
              "What you already investigated and what it ruled out. This is what " +
              "stops the next agent repeating your work.",
            ),
          files: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe("Relevant paths, ideally as path:line, most important first."),
          question: tool.schema
            .string()
            .describe("The single specific question or decision you need answered."),
        },
        async execute(args, ctx) {
          const brief = buildBrief(args, ctx);

          if (profile.escalation === "run") {
            await ctx.ask({
              permission: "fusion_escalate",
              patterns: ["claude -p"],
              always: ["claude -p"],
              metadata: { question: args.question },
            });
            const answer = await runClaudeCode(brief, ctx);
            return {
              title: "Escalated to Claude Code",
              output:
                `Claude Code answered (billed to your subscription, no gateway spend):\n\n${answer}`,
              metadata: { route: "claude -p" },
            };
          }

          // Default: no spend anywhere. Save the brief and tell the user.
          const dir = path.join(ctx.directory, ".fusion");
          fs.mkdirSync(dir, { recursive: true });
          const file = path.join(dir, `escalation-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
          fs.writeFileSync(file, brief);
          const rel = path.relative(ctx.directory, file);

          // Escalations flow back up: write the same brief as a
          // needs-decision envelope in the outbox so the seat layer can pick
          // it up without anyone pasting between chats.
          try {
            const escId = path.basename(file, ".md");
            fs.mkdirSync(outboxDir, { recursive: true });
            fs.writeFileSync(
              path.join(outboxDir, `${escId}.md`),
              renderResultEnvelope({
                id: escId,
                status: "needs-decision",
                seat: "harness",
                session: ctx.sessionID,
                leadModel,
                summary: `Escalation brief: ${args.question.trim().slice(0, 200)}`,
                files: (args.files ?? []).filter(Boolean),
                checks: ctrl.checks.slice(-10),
                stalls: stallsSummary(),
                note: `Full brief: ${rel}\n\n${args.question.trim()}`,
              }),
            );
          } catch (e) {
            console.error(`[fusion] outbox write failed: ${e.message}`);
          }

          // Interactive by design: no -p or --output-format (the human wants
          // a conversation, not print-and-exit) and no --allowed-tools (they
          // can approve tools live, so restricting them would only remove
          // capability). --model is the one flag worth carrying over from
          // runClaudeCode so a pinned claude_model applies to both routes.
          const modelFlag = profile.claude_model ? ` --model ${String(profile.claude_model)}` : "";
          return {
            title: "Escalate to Claude Code",
            output:
              `I cannot crack this, and escalating to a frontier model would spend gateway\n` +
              `balance. The handoff brief is saved to ${rel}.\n\n` +
              `To hand it to Claude Code (subscription, no gateway spend):\n\n` +
              `    claude${modelFlag} "$(cat ${rel})"\n\n` +
              `or open \`claude\` in this directory and paste the brief.\n\n` +
              `--- brief ---\n${brief}\n\n` +
              `STOP HERE. Report this to the user and do not keep retrying the same\n` +
              `approach. If they answer the question, continue from their answer.`,
            metadata: { route: "advise", file },
          };
        },
      }),

      // Seat <-> harness bridge. The seat layer (Chief of Staff, Engineering
      // Lead, ...) writes work orders into .fusion/inbox/ - usually via
      // `oc-fusion work submit`, which validates the contract. The lead lists
      // and accepts them here, executes, and reports a result envelope to
      // .fusion/outbox/. A seat may request capabilities in a brief; only the
      // owner grants them - nothing here self-authorizes spend or publishing.
      work_order: tool({
        description:
          "Work orders from the seat layer. Seats drop validated briefs in " +
          ".fusion/inbox/; 'list' shows pending work, 'accept' claims one and " +
          "returns the brief, 'report' writes the result envelope to " +
          ".fusion/outbox/ for the seat to read back.",
        args: {
          action: tool.schema
            .enum(["list", "accept", "report"])
            .describe("list pending orders, accept one by id, or report a result."),
          id: tool.schema
            .string()
            .optional()
            .describe("Work-order id (the frontmatter id / inbox filename). Required for accept and report."),
          status: tool.schema
            .enum(["completed", "blocked", "needs-decision", "needs-approval"])
            .optional()
            .describe("Result status. Required for report."),
          summary: tool.schema
            .string()
            .optional()
            .describe("What was done or what is blocking. Required for report."),
          note: tool.schema
            .string()
            .optional()
            .describe("For needs-decision / needs-approval: the exact question or authorization the seat must answer."),
        },
        async execute(args, ctx) {
          const agent = ctx.agent ?? agentBySession.get(ctx.sessionID);
          if (agent && agent !== "fusion") {
            return { title: "Work orders", output: "Only the lead seat manages work orders.", metadata: {} };
          }

          if (args.action === "list") {
            const orders = listInbox();
            if (!orders.length) {
              return { title: "Work orders", output: `No work orders in ${path.relative(ctx.directory, inboxDir)}/.`, metadata: { count: 0 } };
            }
            const lines = orders.map((o) => {
              const flags = [
                o.status,
                o.seat ? `from ${o.seat}` : null,
                o.errors.length ? `INVALID: ${o.errors.join("; ")}` : null,
              ].filter(Boolean).join(" - ");
              return `- ${o.id}${o.title ? ` "${o.title}"` : ""} (${flags})`;
            });
            return {
              title: "Work orders",
              output: `${orders.length} order(s) in inbox:\n\n${lines.join("\n")}\n\nAccept one with work_order(action="accept", id="<id>").`,
              metadata: { count: orders.length },
            };
          }

          if (!args.id) {
            return { title: "Work orders", output: "id is required for accept and report.", metadata: {} };
          }

          const inboxFile = path.join(inboxDir, `${args.id}.md`);
          const orders = readOrders();

          if (args.action === "accept") {
            if (!fs.existsSync(inboxFile)) {
              return { title: "Work order", output: `No inbox file for "${args.id}". Run action="list" to see pending orders.`, metadata: {} };
            }
            const text = fs.readFileSync(inboxFile, "utf8");
            const v = validateWorkOrder(text);
            if (!v.ok) {
              return { title: "Work order rejected", output: `Invalid work order "${args.id}":\n${v.errors.map((e) => `- ${e}`).join("\n")}\n\nSend it back to the seat with these errors.`, metadata: { errors: v.errors } };
            }
            const existing = orders.orders[args.id];
            if (existing && existing.status === "in_progress" && existing.session !== ctx.sessionID) {
              return { title: "Work order claimed", output: `"${args.id}" is already in progress in session ${existing.session}. If that session is dead, delete the entry in .fusion/work-orders.json.`, metadata: { status: existing.status } };
            }
            orders.orders[args.id] = {
              status: "in_progress",
              seat: v.meta.seat,
              session: ctx.sessionID,
              claimed: new Date().toISOString(),
            };
            writeOrders(orders);
            logControl({ kind: "work-order", id: args.id, action: "accept", seat: v.meta.seat });
            return {
              title: `Accepted ${args.id}`,
              output:
                `${text}\n\n---\n` +
                `Work order ${args.id} claimed. Execute within its scope and acceptance checks. ` +
                `Money, publishing, deploys and external contact still wait for the owner regardless of what the brief asks. ` +
                `When done - or when a decision is needed - call work_order(action="report", id="${args.id}", status=..., summary=...).`,
              metadata: { status: "in_progress" },
            };
          }

          // report
          if (!args.status || !args.summary) {
            return { title: "Work order", output: "report needs both status and summary.", metadata: {} };
          }
          const env = renderResultEnvelope({
            id: args.id,
            status: args.status,
            seat: orders.orders[args.id]?.seat ?? null,
            session: ctx.sessionID,
            leadModel,
            summary: args.summary,
            note: args.note,
            files: [...ctrl.filesTouched],
            checks: ctrl.checks.slice(-10),
            stalls: stallsSummary(),
          });
          fs.mkdirSync(outboxDir, { recursive: true });
          fs.writeFileSync(path.join(outboxDir, `${args.id}.md`), env);
          orders.orders[args.id] = {
            ...(orders.orders[args.id] ?? {}),
            status: args.status,
            session: ctx.sessionID,
            updated: new Date().toISOString(),
          };
          writeOrders(orders);
          logControl({ kind: "work-order", id: args.id, action: "report", status: args.status });
          return {
            title: `Reported ${args.id}`,
            output: `Result envelope written to ${path.relative(ctx.directory, outboxDir)}/${args.id}.md (status: ${args.status}). The seat layer reads it from there - stop and let it decide what happens next.`,
            metadata: { status: args.status },
          };
        },
      }),
    },

    // Apply the control panel to the agent set at load.
    config: async (cfg) => {
      // Resolve our bundled launcher, not a machine-specific path or cwd.
      // Leave explicit project MCP overrides and enabled:false untouched.
      const graft = cfg.mcp?.graft;
      if (graft?.type === "local" && JSON.stringify(graft.command) === JSON.stringify(["oc-fusion", "graft", "mcp"])) {
        graft.command = ["bash", path.join(HARNESS, "bin", "oc-fusion"), "graft", "mcp"];
      }
      cfg.agent ??= {};
      const set = (name, patch) => { cfg.agent[name] = { ...(cfg.agent[name] ?? {}), ...patch }; };

      set("fusion", {
        model: leadModel,
        // A model with no advertised levels gets no variant: it manages its
        // own effort, and an invented one would either be dropped or
        // rejected.
        ...(leadEffort ? { variant: leadEffort } : {}),
        steps: fast ? 200 : 400,
      });

      // The paid oracle exists only when explicitly chosen. Otherwise it is
      // disabled and the `escalate` tool hands off to Claude Code instead, so
      // a stuck lead cannot quietly spend gateway balance on frontier tokens.
      if (profile.escalation === "fable") {
        set("oracle", { model: oracleBase.model, ...(oracleEffort ? { variant: oracleEffort } : {}) });
      } else {
        set("oracle", { disable: true });
      }
      set("scout", { model: sidekick });
      set("grunt", { model: sidekick });

      // Stamp the discovered/pinned wire id onto every local alias, so the
      // placeholder "local" ids in opencode.jsonc never reach the server.
      if (localWireId && cfg.provider?.llamacpp?.models) {
        for (const m of Object.values(cfg.provider.llamacpp.models)) {
          m.id = localWireId;
        }
      }

      // The critic is applied after the sidekick block on purpose: when the
      // sidekick is remote, critic follows it unless the critic knob overrides.
      if (criticPatch) set("critic", criticPatch);
      else if (!sidekickIsLocal) set("critic", { model: sidekick });
      // else: critic keeps llamacpp/fusion-sidekick-deep from the agent table

      // Prefer the resident child's flags: router presets can override the
      // unit. Follow increases as well as decreases, reserving 1024 tokens
      // per slot for template overhead. Keep the configured output budgets.
      const context = localRuntime?.ctx ?? unit.ctx;
      const parallel = localRuntime?.parallel ?? unit.parallel ?? 1;
      if (context && cfg.provider?.llamacpp?.models) {
        const perSlot = Math.floor(context / parallel) - 1024;
        if (perSlot > 0) {
          for (const m of Object.values(cfg.provider.llamacpp.models)) {
            if (m.limit) {
              m.limit.context = perSlot;
              if (m.limit.output) m.limit.output = Math.min(m.limit.output, Math.floor(perSlot / 2));
            }
          }
          console.error(`[fusion] local context: ${perSlot} tokens (${context} total / ${parallel} slots, 1024 reserved per slot)`);
        }
      }
    },

      // Per-message token accounting. Assistant messages stream in through
    // repeated message.updated events; only the final update carries real
    // totals (finish set, cost > 0 or an error), and one line per message is
    // written, deduped by messageID. Agent attribution comes from the
    // chat.params sessionID map. Not visible here: claude -p escalations
    // (outside opencode) and the small_model title calls (skipped: summary).
    event: async ({ event }) => {
      if (event.type !== "message.updated") return;
      const info = event.properties.info;
      if (info.role !== "assistant" || info.summary) return;
      // Fire once per message: on its completed shape. An errored message
      // never reaches "completed", but its final update still has final
      // token counts, so accept it too and mark it.
      if (!info.time.completed && !info.error && !info.finish) return;
      if (loggedMessages.has(info.id)) return;
      loggedMessages.add(info.id);
      // FIFO cap so a marathon session does not grow the set without bound.
      // (Deleting already-yielded entries during iteration is safe in JS.)
      if (loggedMessages.size > 2000) {
        const it = loggedMessages.values();
        for (let i = 0; i < 1000; i++) {
          const r = it.next();
          if (r.done) break;
          loggedMessages.delete(r.value);
        }
      }

      const line = {
        ts: new Date().toISOString(),
        session: info.sessionID,
        agent: agentBySession.get(info.sessionID) ?? "unknown",
        model: `${info.providerID}/${info.modelID}`,
        in: info.tokens?.input ?? 0,
        out: info.tokens?.output ?? 0,
        reasoning: info.tokens?.reasoning ?? 0,
        cache_read: info.tokens?.cache?.read ?? 0,
        cache_write: info.tokens?.cache?.write ?? 0,
        cost: info.cost ?? 0,
        error: info.error ? info.error.name : undefined,
      };
      try {
        fs.mkdirSync(path.join(directory, ".fusion"), { recursive: true });
        fs.appendFileSync(path.join(directory, ".fusion", "usage.jsonl"), JSON.stringify(line) + "\n");
      } catch (e) {
        // Accounting must never break a chat.
        console.error(`[fusion] usage log write failed: ${e.message}`);
      }
    },

    // Compaction is exactly where "two honest attempts" used to die: the
    // retry history lived in scrollback that prune removes. Inject the
    // measured state into the compaction context so the post-compaction
    // summary carries the counters, not a memory of them.
    "experimental.session.compacting": async (input, output) => {
      const s = renderControllerState(ctrl, {
        stallEdits: profile.stall_edits,
        stallCommands: profile.stall_commands,
        scopeLimit: profile.grunt_max_blast,
      });
      output.context.push(s);
      const orders = readOrders().orders;
      const open = Object.entries(orders).filter(([, o]) => o.status === "in_progress");
      if (open.length) {
        output.context.push(
          `[fusion work orders in progress: ${open.map(([id, o]) => `${id} (from ${o.seat ?? "?"})`).join(", ")}. ` +
            `Report results with the work_order tool.]`,
        );
      }
    },

    "chat.params": async (input, output) => {
      agentBySession.set(input.sessionID, input.agent);
      // FIFO cap: subagent sessions accumulate over a long run; 500 recent
      // mappings is far more than attribution ever needs.
      if (agentBySession.size > 500) {
        agentBySession.delete(agentBySession.keys().next().value);
      }

      const isLocal = input.model?.providerID === "llamacpp";
      if (!isLocal) return;

      const wire = input.model?.api?.id;

      // Eviction guard. The resident model is shared state; a stray model name
      // unloads it and kills whatever it was generating.
      if (profile.guard !== "off" && wire && resident.size && !resident.has(wire)) {
        const msg =
          `[fusion] "${wire}" is not resident (resident: ${[...resident.keys()].join(", ") || "none"}). ` +
          `llama-server runs --models-max ${unit.modelsMax ?? 1}, so this request would unload it mid-flight.`;
        if (profile.guard === "strict") {
          throw new Error(`${msg} Refusing: set "guard": "warn" in fusion.jsonc to allow.`);
        }
        console.error(`${msg} Allowing because guard is "warn".`);
      }

      // Sampling is tuned in the llama-server unit (temp 1.0 / top_p 0.95 /
      // top_k 20 / min_p 0.0). Don't fight it from here.
      delete output.temperature;
      delete output.topP;
      delete output.topK;

      // Per-agent reasoning effort, from the panel. llama.cpp reads this from
      // chat_template_kwargs; it ignores a top-level reasoning_effort.
      const byAgent = profile.local_efforts ?? {};
      const asked = byAgent[input.agent] ?? unit.effort ?? "medium";
      const want = fast && input.agent === "scout" ? "low" : asked;
      output.options = {
        ...(output.options ?? {}),
        chat_template_kwargs: {
          ...(output.options?.chat_template_kwargs ?? {}),
          reasoning_effort: want,
        },
      };
    },

    // Evidence routing, gate side. Runs BEFORE rtk's rewrite (plugin order in
    // opencode.jsonc keeps fusion.js first), so recorded commands are what the
    // model asked for, not the compressed equivalent.
    "tool.execute.before": async (input, output) => {
      const agent = agentBySession.get(input.sessionID) ?? "fusion";
      const args = output?.args ?? {};

      if (input.tool === "task") {
        logControl({ kind: "dispatch", session: input.sessionID, agent, to: args.subagent_type ?? args.agent ?? "?", desc: String(args.description ?? "").slice(0, 120) });
        return;
      }

      if (input.tool === "bash" || input.tool === "shell") {
        const cmd = normalizeCommand(args.command);
        ctrl.pending.set(input.callID, { cmd, agent });
        if (ctrl.pending.size > 500) ctrl.pending.delete(ctrl.pending.keys().next().value);
        const reason = gateCommand(ctrl, cmd, profile.stall_commands);
        if (reason) gate(input.callID, "cmd-stall", reason, { cmd });
        return;
      }

      const file = extractFilePath(input.tool, args);
      if (file) {
        const rel = path.relative(directory, path.resolve(directory, file)) || file;
        ctrl.pending.set(input.callID, { file: rel, agent });
        const isSidekick = agent !== "fusion" && agent !== "oracle";

        const reason = gateEdit(ctrl, rel, agent, {
          stallEdits: profile.stall_edits,
          protectedPaths: profile.protected_paths,
          scopeLimit: profile.grunt_max_blast,
        });
        if (reason) return gate(input.callID, "edit-stall", reason, { file: rel, agent });

        // Up-front blast radius on a sidekick's first touch of each file.
        // Unknown (no graft index, unindexed file) is recorded, never blocked.
        if (isSidekick && profile.scope_check && hasGraft() && !fileScope.has(rel)) {
          const deps = await measureFileScope(rel);
          fileScope.set(rel, { deps, ts: Date.now() });
          logControl({ kind: "scope-file", file: rel, agent, deps });
          if (deps != null && deps > profile.grunt_max_blast) {
            return gate(
              input.callID,
              "scope-file",
              `"${rel}" has ${deps} dependent files (limit ${profile.grunt_max_blast} for the sidekick tier). ` +
                `This surface moves to the lead.`,
              { file: rel, agent, deps },
            );
          }
        }
      }
    },

    // Let the free local model compress oversized tool output before it lands
    // in a paid context. Head and tail are kept verbatim so nothing the model
    // needs to quote exactly is silently lost.
    "tool.execute.after": async (input, output) => {
      if (typeof output.output !== "string") return;
      let text = output.output;

      const agent = agentBySession.get(input.sessionID);

      // ---- evidence routing, outcome side ---------------------------
      // Consume what the before-hook recorded for this call, update the
      // counters, then append any queued notice so the agent sees it.
      const pending = ctrl.pending.get(input.callID);
      if (pending) {
        ctrl.pending.delete(input.callID);
        if (pending.cmd) {
          const exit = output.metadata?.exit;
          const timeout = output.metadata?.timeout === true;
          const failed = (typeof exit === "number" && exit !== 0) || timeout;
          if (failed) {
            const sig = failSignature(text, exit, timeout);
            const f = recordCommandResult(ctrl, pending.cmd, false, sig);
            logControl({ kind: "cmd-fail", session: input.sessionID, agent: pending.agent, cmd: pending.cmd, exit, sig, n: f.n });
            if (f.n >= profile.stall_commands - 1) {
              output.output =
                `${text}\n\n[fusion] This command has now failed ${f.n} time(s) in a row ` +
                `(signature: ${sig}). At ${profile.stall_commands} identical retries are ` +
                `${profile.routing === "enforce" ? "blocked" : "flagged"}. Change the approach ` +
                `or escalate with what the failures ruled out.`;
            }
          } else {
            recordCommandResult(ctrl, pending.cmd, true);
            if (isVerificationCommand(pending.cmd)) {
              recordVerification(ctrl, pending.cmd, exit ?? 0);
              logControl({ kind: "check", session: input.sessionID, agent: pending.agent, cmd: pending.cmd, exit });
            }
          }
        }
        if (pending.file) {
          const e = recordEdit(ctrl, pending.file, pending.agent);
          logControl({ kind: "edit", session: input.sessionID, agent: pending.agent, file: pending.file, n: e.n });

          // Post-edit scope on the real diff. Debounced: blast runs at most
          // every 3rd sidekick edit, since early edits rarely settle the
          // radius. Runs after the edit lands so the measurement is real.
          if (
            profile.scope_check && hasGraft() && !ctrl.scope.exceeded &&
            pending.agent !== "fusion" && pending.agent !== "oracle" &&
            ++blastChecks % 3 === 0
          ) {
            const diff = await measureDiffScope();
            if (diff && diff.impacted > profile.grunt_max_blast) {
              ctrl.scope.exceeded = true;
              ctrl.scope.impacted = diff.impacted;
              ctrl.scope.files = diff.files;
              logControl({ kind: "scope-diff", impacted: diff.impacted, files: diff.files.slice(0, 20), limit: profile.grunt_max_blast });
              output.output =
                `${text}\n\n[fusion] Working-diff blast radius is now ${diff.impacted} files ` +
                `(limit ${profile.grunt_max_blast} for the sidekick tier)` +
                `${profile.routing === "enforce" ? " - further sidekick edits are blocked" : " - would gate sidekick edits"}. ` +
                `The lead takes the remaining edits, or narrow the scope.`;
            }
          }
        }
      }
      const notice = ctrl.notices.get(input.callID);
      if (notice) {
        ctrl.notices.delete(input.callID);
        output.output = `${output.output}\n\n${notice}`;
      }
      // The evidence block may have rewritten output.output; the compression
      // path below works on what is actually there now.
      text = output.output;
      // ---------------------------------------------------------------

      // Only worth doing for the paid tiers; the local agents read for free.
      if (!agent || agent === "scout" || agent === "grunt" || agent === "critic") return;
      if (["todowrite", "task", "question"].includes(input.tool)) return;

      // Genuinely huge output never reaches us intact: opencode truncates to
      // tool_output.max_bytes and writes the full text to a file BEFORE this
      // hook runs. That route is lossless and the file can be grepped, so
      // summarizing a window of the surviving tail is strictly worse than
      // pointing the lead at the file. Say so instead, and keep the text as
      // opencode left it.
      const saved = /Full output saved to:\s*(\S+)/.exec(text);
      if (saved) {
        output.output =
          `${text}\n\n` +
          `[fusion: this was truncated; the complete output is on disk. Do not read that\n` +
          `file yourself. Delegate to scout with the path ${saved[1]} and the specific\n` +
          `question you need answered: it can grep the whole thing for free.]`;
        return;
      }

      if (!profile.compress_tool_output) return;
      // Only fires on large-but-intact output, where there is no file to
      // delegate to and the alternative is the lead swallowing all of it.
      const threshold = Number(profile.compress_threshold) || 25000;
      if (text.length <= threshold) return;

      const head = text.slice(0, 2000);
      const tail = text.slice(-1000);
      const middle = text.slice(2000, -1000);

      try {
        const summary = await localSummarize({ tool: input.tool, middle });
        if (!summary) return;
        output.output =
          `${head}\n\n` +
          `[fusion: ${middle.length} chars of the middle were summarized by the local model. ` +
          `Ask scout to read the source if you need the exact text.]\n\n` +
          `${summary}\n\n` +
          `[end of summary; final 1000 chars verbatim]\n\n${tail}`;
      } catch (e) {
        // Compression is an optimization. Never let it break the tool call.
        console.error(`[fusion] tool-output compression skipped: ${e.message}`);
      }
    },
  };

  function buildBrief(args, ctx) {
    const files = (args.files ?? []).filter(Boolean);
    return [
      `# Escalation from opencode (lead: ${leadModel})`,
      "",
      `Working directory: ${ctx.directory}`,
      "",
      "## Problem",
      args.problem.trim(),
      "",
      "## What I already tried, and what it ruled out",
      args.tried.trim(),
      "",
      ...(files.length ? ["## Relevant files", ...files.map((f) => `- ${f}`), ""] : []),
      "## The question I need answered",
      args.question.trim(),
      "",
      "---",
      "Written by the opencode fusion harness. The lead model above could not",
      "resolve this, so it was handed to you rather than to a paid frontier model.",
      "",
    ].join("\n");
  }

  function runClaudeCode(brief, ctx) {
    return new Promise((resolve, reject) => {
      const model = profile.claude_model;
      // Read-only tools only. A non-interactive `claude -p` cannot be granted
      // approvals mid-run, so anything not pre-allowed just fails and it
      // reasons blind. Reading is what makes the answer grounded; writing is
      // the lead's job once the answer comes back.
      const argv = [
        "-p", brief,
        "--output-format", "text",
        "--allowed-tools", "Read,Glob,Grep,WebSearch,WebFetch",
      ];
      if (model) argv.push("--model", String(model));

      const child = spawn("claude", argv, {
        cwd: ctx.directory,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let out = "", err = "";
      // Claude Code can think for a while; give it room but never hang forever.
      const timer = setTimeout(() => { child.kill("SIGTERM"); }, 15 * 60 * 1000);
      const onAbort = () => { child.kill("SIGTERM"); };
      ctx.abort?.addEventListener?.("abort", onAbort, { once: true });

      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { err += d; });
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(new Error(`could not run \`claude\`: ${e.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        ctx.abort?.removeEventListener?.("abort", onAbort);
        if (code === 0 && out.trim()) return resolve(out.trim());
        reject(new Error(`claude exited ${code}${err.trim() ? `: ${err.trim().slice(0, 500)}` : ""}`));
      });
    });
  }

  async function localSummarize({ tool, middle }) {
    const key = fs.readFileSync(API_KEY_FILE, "utf8").trim();
    const port = unit.port ?? 8080;
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: localWireId, // resident model only; never triggers a load
        stream: false,
        max_tokens: 1200,
        chat_template_kwargs: { reasoning_effort: "low" },
        messages: [
          {
            role: "system",
            content:
              "You compress tool output for another agent. Report only what is in the text: " +
              "errors and their locations, names and paths that matter, counts, and the shape of " +
              "the data. Use a short list. Do not speculate, do not advise, do not add preamble.",
          },
          { role: "user", content: `Output of the \`${tool}\` tool:\n\n${middle.slice(0, 120000)}` },
        ],
      }),
    });
    if (!res.ok) throw new Error(`llama-server returned ${res.status}`);
    const json = await res.json();
    return json?.choices?.[0]?.message?.content?.trim() || null;
  }
};
