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

    // Let the free local model compress oversized tool output before it lands
    // in a paid context. Head and tail are kept verbatim so nothing the model
    // needs to quote exactly is silently lost.
    "tool.execute.after": async (input, output) => {
      const text = output.output;
      if (typeof text !== "string") return;

      const agent = agentBySession.get(input.sessionID);
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
