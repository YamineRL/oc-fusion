// Fusion-style two-tier routing for opencode.
//
// Lead model does the thinking; a free local model absorbs the bulk: Strata
// (the default) or llama.cpp. Knobs live in fusion.jsonc and are applied to
// the agent set at load.
//
// Strata serves one model and answers every model name with it, so it has no
// eviction risk and no resident-id rewrite. It shares the per-agent effort
// and the sampler strip with llama.cpp, and nothing else.
//
// The llama.cpp side is deliberately defensive: llama-server runs with
// --models-max 1, so naming a model that is not resident evicts the resident
// one mid-generation. Every local alias therefore sends the same wire id, and
// the guard below refuses (or warns about) anything else.
//
// Discovery follows the machine. With a systemd unit the unit is parsed for
// flags and `ps` finds the resident model. Without one (macOS, or a server
// on another host reached over a tunnel), or when FUSION_BASE_URL is set,
// the endpoint itself answers: /v1/models for residency, /props for the
// context, panel keys for the rest. All passive GETs, so none can trigger
// a load.
//
// Dual plugin shape: OpenCode v2 calls `default.setup(context)`; v1 hosts
// call `default.server(input)` (detect mode) or the named `server` export
// (iterating loaders). Both bodies share `resolveFusion(directory)` below so
// the routing math exists once.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
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
import {
  FUSION_RPC,
  KNOBS,
  EFFORT_SEATS,
  EFFORT_LEVELS,
  makeNotice,
  makeNoticeStore,
  readPendingFile,
  clearPendingFile,
  findDroppedKeys,
  writePanelKey,
  writePanelEffort,
  usageTotals,
  readUsageRows,
  pruneOldToolOutputs,
  LEAD_RATES,
} from "./panel.mjs";

// Machine-specific locations, overridable. Defaults follow XDG.
const UNIT = process.env.FUSION_UNIT ?? path.join(os.homedir(), ".config/systemd/user/llama-server.service");
const API_KEY_FILE = process.env.FUSION_API_KEY_FILE ?? path.join(os.homedir(), ".config/llama-server/api-key");
// Strata (github.com/Niko1221/Strata). Keep in step with provider "strata"
// in opencode.jsonc; only the tool-output summarizer calls it directly.
const STRATA_URL = process.env.FUSION_STRATA_URL ?? "http://127.0.0.1:8082";
const STRATA_KEY_FILE = process.env.FUSION_STRATA_KEY_FILE ?? path.join(os.homedir(), ".config/strata/api-key");

// Providers that run on your own hardware. Both get the per-agent
// local_efforts and the sampler strip; only llamacpp gets the resident-id
// rewrite, the eviction guard and the context clamp.
const LOCAL_PROVIDERS = ["llamacpp", "strata"];

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
  // Strata engine (github.com/Niko1221/Strata) on its own port. Its own
  // provider, not llamacpp, so the resident-id rewrite and eviction guard
  // never touch it. "strata" is the general model (IQ3_XXS by default; any
  // full-expert size works, see the README). "strata-coder" is the Coder
  // IQ1_M: Strata serves one model, so run the Coder instead of the general
  // model before you select it.
  strata:         "strata/strata-iq3",
  "strata-coder": "strata/strata-coder",
};

// The critic reviews the lead's work, so it should not be a weaker model than
// the edit it audits unless the user says so. Applied independently of the
// sidekick knob. The string values are resolved at load in resolveFusion.
const CRITICS = {
  local:  "local",  // llamacpp/fusion-sidekick-deep; follows a non-llama.cpp sidekick
  strata: "strata", // the Strata model the sidekick uses, else strata-iq3
  flash:  { model: "merge-gateway/zai/glm-5.3-flash", variant: "low" },
  lead:   "lead",   // the lead's own model at low effort
};

const DEFAULTS = {
  base: "glm",
  sidekick: "strata",
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
  critic: "strata",
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

  // Remote llama.cpp only (no systemd unit, or FUSION_BASE_URL set): what
  // HTTP cannot report. local_ctx is the server's TOTAL context (null =
  // read the per-slot context from GET /props), local_parallel its
  // --parallel, server_effort the fallback reasoning_effort for local
  // agents missing from local_efforts.
  local_ctx: null,
  local_parallel: null,
  server_effort: null,

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
  // When the configured sidekick's backend stops answering (passive probe:
  // /health or /v1/models, never a model-named request), sidekick and critic
  // work reroutes to this fallback until the backend is back. Any name from
  // the sidekick list works; a paid model means downtime costs money.
  // null = no fallback, sidekick calls fail visibly instead.
  sidekick_fallback: "glm",
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
// plugins/fusion/. Used so the control panel is found when opencode runs in
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
      if (fs.existsSync(p)) {
        // The file that won decides where /fusion set commands write.
        lastProfileFile = p;
        return { ...DEFAULTS, ...JSON.parse(stripJsonc(fs.readFileSync(p, "utf8"))) };
      }
    } catch (e) {
      console.error(`[fusion] ${path.basename(p)} is not valid JSON, using defaults: ${e.message}`);
    }
  }
  lastProfileFile = null;
  return { ...DEFAULTS };
}
// The file the last readProfile call loaded (null when defaults only).
let lastProfileFile = null;

// The config files opencode could have loaded, in precedence order: the
// project first, then the file OPENCODE_CONFIG names (the harness config
// when run through `oc`), then the global config.
function configCandidates(directory) {
  const home = os.homedir();
  return [
    path.join(directory, "opencode.json"),
    path.join(directory, "opencode.jsonc"),
    ...(process.env.OPENCODE_CONFIG ? [process.env.OPENCODE_CONFIG] : []),
    path.join(home, ".config", "opencode", "opencode.json"),
    path.join(home, ".config", "opencode", "opencode.jsonc"),
  ];
}

// Registry id -> declared wire id for one provider's models, read straight
// from the opencode config files. A plugin's model transform cannot ask the
// registry for this: transforms replay in registration order on a fresh
// state on every rebuild, and the post-phase config builtin runs after file
// plugins, so the model map is always empty when a file plugin's transform
// runs. The project config wins over the global one.
function readConfigWireIds(directory, providerID) {
  const candidates = configCandidates(directory);
  const wire = new Map();
  for (const p of candidates) {
    try {
      const cfg = JSON.parse(stripJsonc(fs.readFileSync(p, "utf8")));
      const models = cfg?.provider?.[providerID]?.models ?? {};
      for (const [key, entry] of Object.entries(models)) {
        if (!wire.has(key)) wire.set(key, entry?.modelID ?? entry?.id ?? key);
      }
    } catch { /* absent or unparsable config is not a plugin problem */ }
  }
  return wire;
}

// One provider's configured baseURL, from the same config files. Remote
// mode needs it: with no unit to parse, the endpoint is the only place the
// server's address is written down.
function readConfigBaseURL(directory, providerID) {
  for (const p of configCandidates(directory)) {
    try {
      const cfg = JSON.parse(stripJsonc(fs.readFileSync(p, "utf8")));
      const u = cfg?.provider?.[providerID]?.options?.baseURL;
      if (u) return String(u);
    } catch { /* absent or unparsable config is not a plugin problem */ }
  }
  return null;
}

// Key files are one key per line; # lines are comments. Take the first usable
// line: the raw file puts comments and other keys into one Authorization
// header, which fetch rejects.
function readKeyFile(file) {
  const key = fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#"));
  if (!key) throw new Error(`no API key found in ${file}`);
  return key;
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
// spawnSync at load time; a plugin has no $ helper on v2.
function residentModels() {
  try {
    const txt = spawnSync("ps", ["-eo", "args="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).stdout ?? "";
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

// ------------------------------------------- remote endpoint as source of truth

// Remote mode: no systemd unit exists to parse (the server runs on another
// host, or FUSION_BASE_URL names it directly). Everything the unit used to
// tell us then comes from the endpoint and the panel: the port from the
// base URL, ctx/parallel from the panel keys (GET /props fills what they
// leave null), the effort fallback from "server_effort".
function readEndpointConfig(profile, baseURL) {
  const out = { ctx: null, port: null, modelsDir: null, modelsMax: null, parallel: null, effort: null, idle: null };
  const m = String(baseURL ?? "").match(/:(\d+)/);
  if (m) out.port = Number(m[1]);
  if (profile?.local_ctx) out.ctx = Number(profile.local_ctx) || null;
  if (profile?.local_parallel) out.parallel = Number(profile.local_parallel) || null;
  if (profile?.server_effort) out.effort = profile.server_effort;
  return out;
}

async function fetchJson(url, key, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// The resident model(s) on a remote llama-server, read passively:
// GET /v1/models only, never a completion, so it cannot trigger a load.
// Router-mode servers report status.value per model ("loaded" | "unloaded"
// | ...) plus the child server's args; a vanilla server lists only what it
// has loaded, so a bare entry counts as resident.
async function remoteResidentModels(baseURL, key) {
  const found = new Map();
  const origin = String(baseURL ?? "").replace(/\/v1\/?$/, "");
  if (!origin) return found;
  const doc = await fetchJson(`${origin}/v1/models`, key);
  for (const m of doc?.data ?? []) {
    if (!m?.id) continue;
    const status = m.status?.value ? String(m.status.value).toLowerCase() : null;
    if (status && !["loaded", "loading", "ready", "sleeping"].includes(status)) continue;
    // Child-server args are a flat argv list; pull --ctx-size/--parallel out.
    const args = Array.isArray(m.status?.args) ? m.status.args : [];
    const flag = (f) => {
      const i = args.indexOf(f);
      return i >= 0 && i + 1 < args.length ? Number(args[i + 1]) || null : null;
    };
    found.set(String(m.id), { ctx: flag("--ctx-size"), parallel: flag("--parallel") });
  }
  return found;
}

// ------------------------------------------------- shared setup (both hosts)

// Everything the two plugin bodies need that does not depend on the host's
// hook API: profile resolution, local-server discovery, controller state,
// graft helpers, work orders, the escalate/summarize machinery, the banner.
async function resolveFusion(directory) {
  const profile = readProfile(directory);

  // Where llama-server lives decides how it is discovered. With a systemd
  // unit the unit is the contract. Without one (macOS, a remote box reached
  // over a tunnel), or when FUSION_BASE_URL is set, the endpoint answers:
  // /v1/models for residency, /props for the context, the panel keys for
  // the rest. All passive GETs; none names a model, so none can load one.
  const forcedBase = process.env.FUSION_BASE_URL || null;
  const remote = Boolean(forcedBase) || !fs.existsSync(UNIT);
  const llamaBase = remote ? forcedBase ?? readConfigBaseURL(directory, "llamacpp") : null;
  const llamaOrigin = llamaBase ? llamaBase.replace(/\/v1\/?$/, "") : null;
  const unit = remote ? readEndpointConfig(profile, llamaBase) : readUnit();

  let llamaKey = null;
  if (remote) {
    try { llamaKey = readKeyFile(API_KEY_FILE); } catch { /* absent key: probes below just fail closed */ }
  }
  const resident = remote ? await remoteResidentModels(llamaBase, llamaKey) : residentModels();
  // /props reports the per-slot context and the slot count; use it for what
  // the panel left null. ctx stays a TOTAL so the per-slot clamp below
  // divides the same way as with a unit.
  if (remote && llamaOrigin && (unit.ctx == null || unit.parallel == null)) {
    const props = await fetchJson(`${llamaOrigin}/props`, llamaKey);
    const slotCtx = props?.default_generation_settings?.n_ctx_slot ?? props?.n_ctx_slot ?? null;
    const slots = Number(props?.total_slots) || null;
    if (unit.ctx == null && slotCtx) unit.ctx = slotCtx * (slots || 1);
    if (unit.parallel == null) unit.parallel = slots;
  }

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

  const sidekick = SIDEKICKS[profile.sidekick] ?? SIDEKICKS[DEFAULTS.sidekick];
  if (!SIDEKICKS[profile.sidekick]) {
    console.error(`[fusion] unknown sidekick "${profile.sidekick}", falling back to "${DEFAULTS.sidekick}". Known: ${Object.keys(SIDEKICKS).join(", ")}`);
  }
  const providerOf = (spec) => String(spec).split("/")[0];
  // Only llama.cpp has a resident model to protect and a unit to clamp to.
  const sidekickIsLlama = providerOf(sidekick) === "llamacpp";
  const sidekickIsStrata = providerOf(sidekick) === "strata";
  // Local = runs on your own hardware, so it costs nothing per token.
  const sidekickIsLocal = LOCAL_PROVIDERS.includes(providerOf(sidekick));

  const criticKnown = Object.hasOwn(CRITICS, profile.critic);
  const criticChoice = criticKnown ? CRITICS[profile.critic] : CRITICS[DEFAULTS.critic];
  if (!criticKnown) {
    console.error(`[fusion] unknown critic "${profile.critic}", falling back to "${DEFAULTS.critic}". Known: ${Object.keys(CRITICS).join(", ")}`);
  }
  const criticEffort = clampEffort("low", base.efforts);
  // Always a concrete { model, variant? }: opencode.jsonc names no critic
  // model, because under v2 a model in the agent table beats the plugin.
  const criticPatch =
    criticChoice === "lead"
      ? { model: leadModel, ...(criticEffort ? { variant: criticEffort } : {}) }
      : criticChoice === "strata"
        // Strata serves one model: a critic on the other Strata alias would
        // reach the same server with the wrong context limit.
        ? { model: sidekickIsStrata ? sidekick : SIDEKICKS.strata }
        : criticChoice === "local"
          // A remote or Strata sidekick takes the critic seat with it.
          ? { model: sidekickIsLlama ? "llamacpp/fusion-sidekick-deep" : sidekick }
          : criticChoice;
  const usesLlama = sidekickIsLlama || providerOf(criticPatch.model) === "llamacpp";

  // reasoning_effort for one local request: the panel's per-agent value, else
  // the llama-server unit's default (llama.cpp only), else medium. Fast mode
  // drops scout to low.
  function effortFor(agent, providerID) {
    const asked = profile.local_efforts?.[String(agent ?? "")] ?? (providerID === "llamacpp" ? unit.effort : null) ?? "medium";
    return fast && String(agent) === "scout" ? "low" : asked;
  }

  // The wire id every local alias sends: pinned via the panel, else whatever
  // the running server has resident. Discovery means the harness cannot ask
  // the server for a model it does not have loaded.
  const localWireId = profile.local_model ?? [...resident.keys()][0] ?? null;
  // Registry id -> declared wire id, from the config files. Plugin
  // transforms run before the post-phase config builtin on every state
  // rebuild, so the registry is always empty when they run; the files are
  // the only reliable place to resolve an alias's declared wire id.
  const cfgWireIds = readConfigWireIds(directory, "llamacpp");
  // Router presets put context flags on the child, not the systemd unit.
  const localRuntime = resident.get(localWireId);
  if (!localWireId && usesLlama) {
    console.error("[fusion] no local model pinned and none resident (is llama-server running?). Local agents will fail until it is up.");
  }

  // -------------------------------------------- live resident read
  //
  // `resident` above is a load-time snapshot from ps. The resident model
  // can change under a running server (the panel can swap it, or the
  // server can come up after plugin load), so every decision that puts a
  // model name on the wire re-reads it: GET /v1/models is the only passive
  // probe; it never names a model, so it cannot start a load or evict one.
  // Answers cache for a few seconds; failures are not cached, so a
  // recovering server is seen on the next request.
  const RESIDENT_TTL_MS = 3000;
  const live = { at: 0, url: "", ids: null, inflight: null, auth: null };

  // Header candidates for the probe: the request's own headers first
  // (they already carry the provider key when it was configured), then
  // each usable line of the key file as a Bearer token.
  function authCandidates(headers) {
    const base = new Headers(headers ?? undefined);
    const out = [base];
    if (!base.get("authorization")) {
      try {
        for (const line of fs.readFileSync(API_KEY_FILE, "utf8").split("\n")) {
          const k = line.trim();
          if (!k || k.startsWith("#")) continue;
          const h = new Headers(base);
          h.set("authorization", `Bearer ${k}`);
          out.push(h);
        }
      } catch {}
    }
    if (live.auth) return [live.auth, ...out.filter((h) => h !== live.auth)];
    return out;
  }

  async function readResidentLive(baseURL, headers) {
    const url = new URL("/v1/models", baseURL).toString();
    if (live.ids && live.url === url && Date.now() - live.at < RESIDENT_TTL_MS) return live.ids;
    if (live.inflight?.url === url) return live.inflight.p;
    const p = (async () => {
      try {
        let res = null;
        for (const h of authCandidates(headers)) {
          res = await fetch(url, { headers: h, signal: AbortSignal.timeout(2000) });
          if (res.ok) { live.auth = h; break; }
          if (res.status !== 401 && res.status !== 403) { res = null; break; }
        }
        if (!res?.ok) return null;
        const data = await res.json();
        const ids = new Set();
        for (const m of data?.data ?? []) {
          if (m?.status?.value === "loaded" && m?.id) ids.add(String(m.id));
        }
        // An empty answer is transient (a model may still be loading), so
        // only a non-empty read is cached; the next call re-probes.
        if (ids.size) {
          live.at = Date.now();
          live.url = url;
          live.ids = ids;
        }
        return ids;
      } catch {
        return null;
      } finally {
        live.inflight = null;
      }
    })();
    live.inflight = { url, p };
    return p;
  }

  // The wire id it is safe to send: the pinned local_model when it is
  // still resident, else the resident model. null means "do not send":
  // no resident model, an unreadable server, or a pin that would evict.
  let lastWireId = localWireId;
  function pickWireId(ids) {
    if (!ids || !ids.size) return null;
    if (profile.local_model) return ids.has(profile.local_model) ? profile.local_model : null;
    if (lastWireId && ids.has(lastWireId)) return lastWireId;
    lastWireId = ids.values().next().value;
    return lastWireId;
  }

  // ------------------------------------------------- evidence routing
  //
  // The controller: measured stalls and measured scope pick the tier, not
  // the lead's judgment. State lives in plugin memory (survives compaction)
  // and is mirrored to .fusion/control.jsonl (survives restarts). Limits
  // come from the panel; "observe" annotates and logs, "enforce" refuses the
  // call (v1 throws, v2 redirects to the fusion_blocked tool; see gateV2).
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
  const blastTick = () => ++blastChecks;
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
    `critic ${criticPatch.model}${
      profile.critic === "lead" ? " (self-review)" : LOCAL_PROVIDERS.includes(providerOf(criticPatch.model)) ? " [free]" : ""
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

  function printBanner() {
    console.error(banner);
    if (fast && !FAST_TWIN[base.model]) {
      console.error(
        leadEffort
          ? `[fusion] note: the gateway publishes no -fast twin for ${base.model}; fast = one notch less reasoning + tighter step budget.`
          : `[fusion] note: ${base.model} advertises no reasoning levels, so fast = just the tighter step budget for it.`,
      );
    }
    if (unit.ctx && usesLlama) {
      console.error(
        remote
          ? `[fusion] llama-server endpoint ${llamaBase}: ctx ${unit.ctx}, parallel ${unit.parallel ?? "?"}`
          : `[fusion] llama-server unit: ctx ${unit.ctx}, parallel ${unit.parallel}, models-max ${unit.modelsMax}, idle-sleep ${unit.idle}s`,
      );
    }
    if (sidekickIsLlama && resident.size && !resident.has(localWireId)) {
      console.error(`[fusion] WARNING: sidekick wants "${localWireId}" but resident is "${[...resident.keys()].join(", ")}". First sidekick call will evict it.`);
    }
  }

  // ------------------------------------------------- shared tool bodies
  //
  // Both hosts normalize their tool ctx to { agent, sessionID, directory,
  // ask, signal } and get the v1-shaped { title, output, metadata } back;
  // each host maps that onto its own result contract.

  function buildBrief(args, t) {
    const files = (args.files ?? []).filter(Boolean);
    return [
      `# Escalation from opencode (lead: ${leadModel})`,
      "",
      `Working directory: ${t.directory}`,
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

  function runClaudeCode(brief, t) {
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
        cwd: t.directory,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let out = "", err = "";
      // Claude Code can think for a while; give it room but never hang forever.
      const timer = setTimeout(() => { child.kill("SIGTERM"); }, 15 * 60 * 1000);
      const onAbort = () => { child.kill("SIGTERM"); };
      t.signal?.addEventListener?.("abort", onAbort, { once: true });

      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { err += d; });
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(new Error(`could not run \`claude\`: ${e.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        t.signal?.removeEventListener?.("abort", onAbort);
        if (code === 0 && out.trim()) return resolve(out.trim());
        reject(new Error(`claude exited ${code}${err.trim() ? `: ${err.trim().slice(0, 500)}` : ""}`));
      });
    });
  }

  // escalate() body, host-agnostic. `t.ask` must throw on decline (v1 ctx.ask
  // already does; the v2 adapter throws on deny/timeout/missing channel).
  async function escalateImpl(args, t) {
    const brief = buildBrief(args, t);

    if (profile.escalation === "run") {
      await t.ask({
        permission: "fusion_escalate",
        patterns: ["claude -p"],
        always: ["claude -p"],
        metadata: { question: args.question },
      });
      const answer = await runClaudeCode(brief, t);
      return {
        title: "Escalated to Claude Code",
        output:
          `Claude Code answered (billed to your subscription, no gateway spend):\n\n${answer}`,
        metadata: { route: "claude -p" },
      };
    }

    // Default: no spend anywhere. Save the brief and tell the user.
    const dir = path.join(t.directory, ".fusion");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `escalation-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
    fs.writeFileSync(file, brief);
    const rel = path.relative(t.directory, file);

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
          session: t.sessionID,
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
  }

  async function workOrderImpl(args, t) {
    const agent = t.agent;
    if (agent && agent !== "fusion") {
      return { title: "Work orders", output: "Only the lead seat manages work orders.", metadata: {} };
    }

    if (args.action === "list") {
      const orders = listInbox();
      if (!orders.length) {
        return { title: "Work orders", output: `No work orders in ${path.relative(t.directory, inboxDir)}/.`, metadata: { count: 0 } };
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
      return { title: "Work order", output: "id is required for accept and report.", metadata: {} };
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
      if (existing && existing.status === "in_progress" && existing.session !== t.sessionID) {
        return { title: "Work order claimed", output: `"${args.id}" is already in progress in session ${existing.session}. If that session is dead, delete the entry in .fusion/work-orders.json.`, metadata: { status: existing.status } };
      }
      orders.orders[args.id] = {
        status: "in_progress",
        seat: v.meta.seat,
        session: t.sessionID,
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
      session: t.sessionID,
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
      session: t.sessionID,
      updated: new Date().toISOString(),
    };
    writeOrders(orders);
    logControl({ kind: "work-order", id: args.id, action: "report", status: args.status });
    return {
      title: `Reported ${args.id}`,
      output: `Result envelope written to ${path.relative(t.directory, outboxDir)}/${args.id}.md (status: ${args.status}). The seat layer reads it from there - stop and let it decide what happens next.`,
      metadata: { status: args.status },
    };
  }

  // The summarizer runs on the sidekick's own local server: Strata when the
  // sidekick is Strata, else llama-server (also for a remote sidekick, as
  // before: summaries stay free or are skipped).
  async function localSummarize({ tool: toolName, middle }) {
    let base, key, model;
    if (sidekickIsStrata) {
      base = STRATA_URL;
      key = readKeyFile(STRATA_KEY_FILE);
      // Strata answers every model name with the one model it serves, so
      // the alias cannot evict anything.
      model = sidekick.slice(sidekick.indexOf("/") + 1);
    } else {
      base = remote ? llamaOrigin : `http://127.0.0.1:${unit.port ?? 8080}`;
      if (!base) {
        throw new Error("no llama-server endpoint: no unit, no FUSION_BASE_URL, no provider.llamacpp baseURL");
      }
      key = readKeyFile(API_KEY_FILE);
      // Same rule as the wire stamp: a load-time name can be stale, so the
      // resident model is re-read here. A bad read means no summarizer call.
      model = pickWireId(await readResidentLive(base, { authorization: `Bearer ${key}` }));
      if (!model) throw new Error("no resident model on llama-server; refusing to name one");
    }
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
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
          { role: "user", content: `Output of the \`${toolName}\` tool:\n\n${middle.slice(0, 120000)}` },
        ],
      }),
    });
    if (!res.ok) throw new Error(`${sidekickIsStrata ? "strata" : "llama-server"} returned ${res.status}`);
    const json = await res.json();
    return json?.choices?.[0]?.message?.content?.trim() || null;
  }

  function appendUsage(line) {
    try {
      fs.mkdirSync(fusionDir, { recursive: true });
      fs.appendFileSync(path.join(fusionDir, "usage.jsonl"), JSON.stringify(line) + "\n");
    } catch (e) {
      // Accounting must never break a chat.
      console.error(`[fusion] usage log write failed: ${e.message}`);
    }
  }

  return {
    profile, unit, remote, llamaBase, llamaOrigin,
    // Strata's address comes from the same config files the server reads;
    // STRATA_URL is the fallback for the summarizer path only. Provider
    // baseURLs conventionally end in /v1; the health endpoint does not.
    strataBase: (readConfigBaseURL(directory, "strata") ?? STRATA_URL).replace(/\/v1\/?$/, ""),
    // The file /fusion set commands write back to (null = defaults only).
    profileFile: lastProfileFile,
    directory,
    base, oracleBase, oracleEffort, fast, leadEffort, leadModel,
    sidekick, sidekickIsLocal, sidekickIsLlama, sidekickIsStrata, criticPatch, resident, localWireId, localRuntime,
    providerOf,
    cfgWireIds, readResidentLive, pickWireId, effortFor,
    ctrl, fusionDir, controlLog, ordersFile, inboxDir, outboxDir,
    logControl, graftBin, hasGraft, graftJson, fileScope, blastTick,
    measureFileScope, measureDiffScope, readOrders, writeOrders, listInbox,
    stallsSummary, buildBrief, runClaudeCode, localSummarize, appendUsage,
    banner, printBanner, escalateImpl, workOrderImpl,
  };
}

// ============================================================ v1 host
//
// The v1 plugin contract (opencode 1.x): the host calls this and consumes the
// returned hook object. Kept because the Mac still runs v1; the file stays
// one source of truth for both versions.

// v1 only. The plugin lives in plugins/fusion/, so no node_modules is on its
// resolve path. v1 installs @opencode-ai/plugin into its global config dir
// (and into a .opencode/ it loads), so look there when the bare import fails.
async function importPluginSdk() {
  try {
    return await import("@opencode-ai/plugin");
  } catch (err) {
    const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
    for (const base of [path.join(HARNESS, ".opencode"), path.join(configHome, "opencode")]) {
      const dir = path.join(base, "node_modules", "@opencode-ai", "plugin");
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
        const entry = pkg.exports?.["."]?.import ?? pkg.module ?? pkg.main ?? "index.js";
        return await import(pathToFileURL(path.join(dir, entry)).href);
      } catch {}
    }
    throw err;
  }
}

export const server = async ({ directory }) => {
  const F = await resolveFusion(directory);
  const {
    profile, unit, oracleBase, oracleEffort, fast, leadEffort, leadModel,
    sidekick, sidekickIsLocal, sidekickIsLlama, criticPatch, resident, localWireId, localRuntime,
    ctrl, inboxDir, outboxDir, logControl, graftBin, hasGraft, fileScope,
    blastTick, measureFileScope, measureDiffScope, readOrders, writeOrders,
    listInbox, stallsSummary, appendUsage, banner, printBanner,
    escalateImpl, workOrderImpl, localSummarize, effortFor,
  } = F;
  const { tool } = await importPluginSdk();

  // Track which agent owns a session so tool-output compression only fires
  // for the paid tiers. tool.execute.after does not carry the agent itself.
  const agentBySession = new Map();
  // Message IDs already written to the usage log this run (see event hook).
  const loggedMessages = new Set();

  printBanner();

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
          return escalateImpl(args, {
            agent: ctx.agent ?? agentBySession.get(ctx.sessionID),
            sessionID: ctx.sessionID,
            directory: ctx.directory,
            ask: (o) => ctx.ask(o),
            signal: ctx.abort,
          });
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
          return workOrderImpl(args, {
            agent: ctx.agent ?? agentBySession.get(ctx.sessionID),
            sessionID: ctx.sessionID,
            directory: ctx.directory,
          });
        },
      }),
    },

    // Apply the control panel to the agent set at load.
    config: async (cfg) => {
      // Resolve our bundled launcher, not a machine-specific path or cwd.
      // Leave explicit project MCP overrides and enabled:false untouched.
      const graft = cfg.mcp?.graft;
      if (graft?.type === "local" && JSON.stringify(graft.command) === JSON.stringify(["oc-fusion", "graft", "mcp"])) {
        graft.command = ["bash", graftBin, "graft", "mcp"];
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

      // The critic knob is resolved in resolveFusion (critic "local" follows
      // a non-llama.cpp sidekick).
      set("critic", criticPatch);

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
      appendUsage(line);
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

      const providerID = input.model?.providerID;
      if (!LOCAL_PROVIDERS.includes(providerID)) return;

      const wire = input.model?.api?.id;

      // Eviction guard. The resident model is shared state; a stray model name
      // unloads it and kills whatever it was generating. llama.cpp only:
      // Strata answers every name with its one model, so nothing can evict.
      if (providerID === "llamacpp" && profile.guard !== "off" && wire && resident.size && !resident.has(wire)) {
        const msg =
          `[fusion] "${wire}" is not resident (resident: ${[...resident.keys()].join(", ") || "none"}). ` +
          `llama-server runs --models-max ${unit.modelsMax ?? 1}, so this request would unload it mid-flight.`;
        if (profile.guard === "strict") {
          throw new Error(`${msg} Refusing: set "guard": "warn" in fusion.jsonc to allow.`);
        }
        console.error(`${msg} Allowing because guard is "warn".`);
      }

      // Sampling is tuned on the server (the llama-server unit, or Strata's
      // config "sampling"). Don't fight it from here.
      delete output.temperature;
      delete output.topP;
      delete output.topK;

      // Per-agent reasoning effort, from the panel. llama.cpp reads this from
      // chat_template_kwargs; it ignores a top-level reasoning_effort. Strata
      // reads both, and chat_template_kwargs wins.
      const want = effortFor(input.agent, providerID);
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
            blastTick() % 3 === 0
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
};

// ============================================================ v2 host
//
// OpenCode v2 plugin contract: the host calls `default.setup(context)` and
// every capability is registered through a domain transform or hook.
//
// Mapping from the v1 hooks:
//   config (agent routing)      -> agent.transform / model.transform / mcp.transform
//   chat.params (guard)         -> session.hook("model.request")
//   chat.params (wire id, effort) -> session.hook("http.request"), request body rewrite
//   experimental.session.compacting -> session.hook("compaction")
//   tool.execute.before/after   -> tool.hook("execute.before"/"execute.after")
//   event (usage accounting)    -> event.subscribe(), session.step.* events
//
// Notable v2 differences encoded below:
//   - Registry transforms cannot beat config: they replay in registration
//     order on an empty state, and the post-phase config builtin registers
//     after file plugins. update() writes survive only for fields config
//     never declares; remove() never sticks. The wire model id and
//     chat_template_kwargs therefore ride the http.request hook, which sees
//     the final serialized Request after all transforms have run.
//   - `chat_template_kwargs` cannot ride `options`/providerOptions: the
//     OpenAI-compatible driver decodes provider options through a closed
//     schema and drops unknown keys. Agent.Info.request.body deep-merges
//     into the wire JSON (the declarative copy below), and the http.request
//     rewrite is the authoritative stamp.
//   - Throwing inside a promise hook is a fiber defect, not a tool error:
//     it would kill the whole step (including sibling tool calls). Enforce
//     mode therefore redirects `event.tool` to `fusion_blocked`, a refusal
//     tool that returns the gate reason as normal output. The transcript
//     keeps the original call name (the runner records `event.name` from
//     the streamed call, not the redirected one).
//   - `execute.before`/`execute.after` events carry `agent` directly, so the
//     v1 session->agent attribution map is not needed.
//   - Under codemode/batch execution inner calls share the parent's callID,
//     so `ctrl.pending` holds a FIFO queue per id, not a single entry.
//   - Tool-output truncation runs AFTER `execute.after`, so the truncation
//     marker cannot appear here; the compression path below now also covers
//     what would have been truncated (the marker check is kept harmlessly).

const setupV2 = async (ctx) => {
  const directory = ctx.location.directory;
  let F = await resolveFusion(directory);
  // S() is the live profile view: hooks read through it so a `/fusion set`
  // (or a config edit + registry reload) changes behavior on the next
  // request, not on a server restart.
  const S = () => F;
  const refresh = async () => {
    const prev = F;
    F = await resolveFusion(directory);
    // Controller counters, the scope cache and the blast counter are
    // session state, not config: they survive a profile change.
    F.ctrl = prev.ctrl;
    F.fileScope = prev.fileScope;
    F.blastTick = prev.blastTick;
  };
  const {
    ctrl, inboxDir, outboxDir, fusionDir, logControl, graftBin, hasGraft, fileScope,
    blastTick, measureFileScope, measureDiffScope, readOrders, writeOrders,
    listInbox, stallsSummary, appendUsage,
  } = F;

  F.printBanner();
  const registrations = [];

  // -------------------------------------------------- notices (TUI side)
  //
  // Every harness failure a TUI user must see becomes a notice: kind, one
  // sentence about what happened, one action that fixes or routes around
  // it. Deduped by id for the life of this server; emitted live over RPC
  // and queued so a TUI that connects later still gets them.
  const notices = makeNoticeStore();
  const pendingFile = path.join(fusionDir, "pending-notices.jsonl");
  let rpcEvents = null;
  const emitNotice = (kind, message, action, extra = {}) => {
    const n = makeNotice(kind, message, action, extra);
    if (!notices.offer(n)) return n;
    logControl({ kind: "notice", notice: n.kind, session: n.sessionID, message: n.message });
    if (rpcEvents) void rpcEvents.emit("notice", n).catch(() => {});
    return n;
  };
  // bin/oc-server writes launch-time findings (version skew, missing
  // backends) here because its warnings go to a stderr the TUI never shows.
  const drainPendingFile = () => {
    for (const n of readPendingFile(pendingFile)) {
      emitNotice(n.kind ?? "external", n.message, n.action, n);
    }
    clearPendingFile(pendingFile);
  };
  drainPendingFile();

  // ------------------------------------------------ backend health + fallback
  //
  // Probes are passive only: /v1/models and /health never name a model, so
  // they cannot load or evict one. Results cache briefly; down answers
  // expire faster so a recovering backend gets retried soon.
  const health = {
    llamacpp: { ok: null, at: 0 },
    strata: { ok: null, at: 0 },
  };
  const backendDown = { llamacpp: false, strata: false };
  const HEALTH_TTL_UP_MS = 30_000;
  const HEALTH_TTL_DOWN_MS = 10_000;

  const checkBackend = async (providerID, { force = false } = {}) => {
    const h = health[providerID];
    const ttl = h.ok === false ? HEALTH_TTL_DOWN_MS : HEALTH_TTL_UP_MS;
    if (!force && h.ok !== null && Date.now() - h.at < ttl) return h.ok;
    let ok = false;
    try {
      if (providerID === "llamacpp") {
        const base = S().llamaBase ?? `http://127.0.0.1:${S().unit.port ?? 8080}`;
        ok = (await S().readResidentLive(base, {})) !== null;
      } else {
        const base = S().strataBase;
        const res =
          (await fetch(`${base}/health`, { signal: AbortSignal.timeout(2500) }).catch(() => null)) ??
          (await fetch(`${base}/v1/models`, {
            headers: { authorization: `Bearer ${readKeyFile(STRATA_KEY_FILE)}` },
            signal: AbortSignal.timeout(2500),
          }).catch(() => null));
        ok = Boolean(res?.ok);
      }
    } catch {
      ok = false;
    }
    h.ok = ok;
    h.at = Date.now();
    return ok;
  };

  const markBackend = (providerID, down, detail = "") => {
    if (backendDown[providerID] === down) return;
    backendDown[providerID] = down;
    const name = providerID === "strata" ? "Strata" : "llama-server";
    if (down) {
      const fb = S().profile.sidekick_fallback;
      emitNotice(
        "backend-down",
        `${name} is not answering${detail ? ` (${detail})` : ""}.`,
        fb
          ? `Sidekick work now goes to the "${fb}" fallback until ${name} is back.`
          : `Start ${name}, or set "sidekick_fallback" in fusion.jsonc so work can continue.`,
        { severity: "error" },
      );
    } else {
      emitNotice("backend-up", `${name} is answering again.`, "Sidekick work is back on the local model.", {
        severity: "info",
      });
    }
    // Replay the agent transform so sidekick/critic seats reroute (or
    // reroute back) immediately, not on the next restart.
    void ctx.agent.reload?.().catch?.(() => {});
    void ctx.model.reload?.().catch?.(() => {});
  };

  // Sidekick seats the profile actually routes to each local backend.
  const localSeatsUse = (providerID) => {
    const { sidekick, criticPatch, providerOf } = S();
    return providerOf(sidekick) === providerID || providerOf(criticPatch.model) === providerID;
  };

  // Initial probes run in parallel; a down backend flips its seats to the
  // fallback before the first request lands.
  await Promise.all(
    LOCAL_PROVIDERS.map(async (providerID) => {
      if (!localSeatsUse(providerID)) return;
      const ok = await checkBackend(providerID, { force: true });
      if (!ok) markBackend(providerID, true, "health probe failed");
    }),
  );

  // Recovery probe: a down backend is re-probed quietly; an answering one
  // flips the seats back and emits a single "back up" notice.
  const healthTimer = setInterval(() => {
    for (const providerID of LOCAL_PROVIDERS) {
      if (!backendDown[providerID]) continue;
      void checkBackend(providerID, { force: true }).then((ok) => {
        if (ok) markBackend(providerID, false);
      });
    }
  }, HEALTH_TTL_UP_MS);
  healthTimer.unref?.();

  // ----------------------------------------------- dropped-settings scan
  //
  // opencode 2.x normalizes the config and silently drops keys v1 honored.
  // Keys the harness keeps deliberately (v1 still runs on the Mac) are
  // audited and listed in the status output; anything else dropped gets a
  // one-time notice, because a dead setting that looks live is a lie.
  const configAudit = (() => {
    const audited = new Set();
    const unaudited = new Set();
    let pruneEnabled = false;
    for (const cfgPath of configCandidates(directory)) {
      try {
        const cfg = JSON.parse(stripJsonc(fs.readFileSync(cfgPath, "utf8")));
        if (cfg?.compaction?.prune === true) pruneEnabled = true;
        const r = findDroppedKeys(cfg);
        for (const k of r.audited) audited.add(k);
        for (const k of r.unaudited) unaudited.add(k);
      } catch {
        /* absent or unparsable config is not a plugin problem */
      }
    }
    return { audited: [...audited].sort(), unaudited: [...unaudited].sort(), pruneEnabled };
  })();
  if (configAudit.unaudited.length) {
    emitNotice(
      "dropped-settings",
      `opencode v2 ignores ${configAudit.unaudited.length} setting(s) in the config: ${configAudit.unaudited.slice(0, 4).join(", ")}${configAudit.unaudited.length > 4 ? ", …" : ""}.`,
      "They do nothing here. Remove them, or run /fusion status for the full list.",
    );
  }

  // "provider/model" spec -> Model.Ref {providerID, id, variant?}
  const splitModel = (spec) => {
    const s = String(spec ?? "");
    const i = s.indexOf("/");
    return i < 0 ? { providerID: "", id: s } : { providerID: s.slice(0, i), id: s.slice(i + 1) };
  };
  const refOf = (model, variant) => ({ ...splitModel(model), ...(variant ? { variant } : {}) });

  // ------------------------------------------------ transforms: routing
  //
  // Ordering reality: State rebuilds replay transforms in registration order
  // on an empty map, and the post-phase config builtin (opencode.config.*)
  // registers after file plugins. So a file plugin's transform always runs
  // on an empty registry, and remove()/get()-guarded writes cannot stick.
  // update() still works for it: it creates the entry early and the config
  // transform then merges only its *declared* fields on top, leaving fields
  // the config never sets (hidden, request.body, cost) intact. Anything
  // that must beat a declared field lives on a request-time hook instead
  // (see http.request below).

  await ctx.agent.transform((editor) => {
    const { profile, fast, leadModel, leadEffort, oracleBase, oracleEffort, sidekick, criticPatch, effortFor } = S();
    const seat = (id, fn) => editor.update(id, fn);

    seat("fusion", (a) => {
      a.model = refOf(leadModel, leadEffort);
      a.steps = fast ? 200 : 400;
    });

    // The paid oracle exists only when explicitly chosen. Otherwise it is
    // marked hidden (survives the config merge: the config declares no
    // `hidden`) and dispatch to it is refused by the oracle gate in
    // execute.before. A plain remove() is overwritten by the config
    // transform, so hiding + gating is the v2 equivalent of disabling.
    if (profile.escalation === "fable") {
      seat("oracle", (a) => { a.model = refOf(oracleBase.model, oracleEffort); });
    } else {
      seat("oracle", (a) => { a.hidden = true; });
    }

    // Backend fallback: when a local backend is down and the panel names a
    // fallback, sidekick seats reroute to it until the probe reports the
    // backend back. A fallback that is itself a down local backend is not
    // taken.
    const reroute = (modelRef) => {
      const down = modelRef?.providerID && backendDown[modelRef.providerID];
      if (!down) return modelRef;
      const fbSpec = profile.sidekick_fallback && SIDEKICKS[profile.sidekick_fallback];
      if (!fbSpec) return modelRef;
      const fbRef = refOf(fbSpec);
      return backendDown[fbRef.providerID] ? modelRef : fbRef;
    };

    // These writes stick only because opencode.jsonc names no model for
    // scout, grunt or critic: a model declared there beats this transform.
    const sideRef = reroute(refOf(sidekick));
    for (const id of ["scout", "grunt"]) seat(id, (a) => { a.mode = "subagent"; a.model = sideRef; });

    // The critic knob is resolved in resolveFusion (critic "local" follows
    // a non-llama.cpp sidekick).
    const criticRef = reroute(refOf(criticPatch.model, criticPatch.variant));
    seat("critic", (a) => { a.mode = "subagent"; a.model = criticRef; });

    // Per-agent local reasoning effort, the declarative copy. llama.cpp
    // and Strata read chat_template_kwargs from the request body;
    // providerOptions silently drops the key, so it rides request.body. The
    // authoritative stamp is the http.request hook below (it also reaches
    // agents this transform cannot see, e.g. ones config declares after us).
    const seats = [
      ["scout", sideRef],
      ["grunt", sideRef],
      ["critic", criticRef],
    ];
    for (const [id, modelRef] of seats) {
      if (!LOCAL_PROVIDERS.includes(modelRef?.providerID)) continue;
      const want = effortFor(id, modelRef.providerID);
      if (want == null) continue;
      seat(id, (a) => {
        a.request ??= { settings: {}, headers: {}, body: {} };
        a.request.body = {
          ...(a.request.body ?? {}),
          chat_template_kwargs: {
            ...(a.request.body?.chat_template_kwargs ?? {}),
            reasoning_effort: want,
          },
        };
      });
    }
  });

  // Registry stamping is best-effort: where config declares a modelID or a
  // limit it wins the ordering, and the http.request hook rewrites the wire
  // model id regardless. This transform still helps registries built from
  // sources without a declared wire id or context size.
  await ctx.model.transform((editor) => {
    const { localWireId, localRuntime, unit } = S();
    for (const m of editor.list("llamacpp")) {
      if (localWireId) m.modelID = localWireId;
    }

    // Prefer the resident child's flags: router presets can override the
    // unit. Follow increases as well as decreases, reserving 1024 tokens
    // per slot for template overhead. Keep the configured output budgets.
    const context = localRuntime?.ctx ?? unit.ctx;
    const parallel = localRuntime?.parallel ?? unit.parallel ?? 1;
    if (context) {
      const perSlot = Math.floor(context / parallel) - 1024;
      if (perSlot > 0) {
        for (const m of editor.list("llamacpp")) {
          if (m.limit) {
            m.limit.context = perSlot;
            if (m.limit.output) m.limit.output = Math.min(m.limit.output, Math.floor(perSlot / 2));
          }
        }
        console.error(`[fusion] local context: ${perSlot} tokens (${context} total / ${parallel} slots, 1024 reserved per slot)`);
      }
    }
  });

  // Resolve our bundled launcher, not a machine-specific path or cwd.
  // Leave explicit project MCP overrides and enabled:false untouched.
  // NOTE: same ordering trap as above: the graft entry comes from the
  // post-phase config builtin, so get("graft") is empty here today and this
  // is currently a no-op under v2. oc-fusion resolves via PATH, which is
  // what the rewrite exists to make robust; kept for hosts where plugin
  // transforms run after config.
  await ctx.mcp.transform((editor) => {
    const graft = editor.get("graft");
    if (graft?.type === "local" && JSON.stringify(graft.command) === JSON.stringify(["oc-fusion", "graft", "mcp"])) {
      editor.update("graft", (m) => { m.command = ["bash", graftBin, "graft", "mcp"]; });
    }
  });

  // ------------------------------------------------------------ tools

  // v2 has no ctx.ask; `escalation: "run"` gates through the question tool
  // instead. Deny, timeout, or a missing question tool all decline.
  const v2Ask = (tctx) => async ({ permission, metadata }) => {
    const tools = await ctx.tool.list();
    const question = tools.find((t) => t.id === "question" || t.name === "question");
    if (!question) throw new Error("[fusion] escalation run-mode needs an approval channel; the question tool is unavailable");
    const prompt = String(metadata?.question ?? "").trim();
    const signals = [tctx.signal, AbortSignal.timeout(120_000)].filter(Boolean);
    const signal = typeof AbortSignal.any === "function" && signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    const res = await Promise.resolve(question.execute(
      {
        questions: [
          {
            question: `Allow \`claude -p\` to run this escalation?${prompt ? ` Question: ${prompt}` : ""}`,
            header: "Escalate",
            options: [
              { label: "Run claude -p", description: "Subscription route, read-only tools only." },
              { label: "Decline", description: "Keep the brief; do not spend." },
            ],
          },
        ],
      },
      {
        sessionID: tctx.sessionID,
        agent: tctx.agent,
        messageID: tctx.messageID,
        id: tctx.id,
        signal,
        progress: tctx.progress,
      },
    ));
    const answers = res?.output?.answers ?? res?.metadata?.answers;
    const first = Array.isArray(answers) ? answers[0] : null;
    const picked = Array.isArray(first) ? first[0] : first;
    if (picked !== "Run claude -p") {
      throw new Error(`[fusion] escalation declined${picked ? ` (answer: ${picked})` : ""}`);
    }
  };

  // v1 results were {title, output, metadata}; v2 wants {content, metadata}.
  const v2Result = (r) => ({ content: r.output, metadata: { ...(r.metadata ?? {}), title: r.title } });

  await ctx.tool.transform((editor) => {
    editor.add({
      name: "escalate",
      description:
        "Hand a problem you cannot solve to Claude Code, which runs on a " +
        "subscription rather than gateway balance. Use this instead of " +
        "burning frontier tokens. Call it only after you have actually " +
        "investigated: the brief you write is the whole value of the handoff.",
      input: {
        type: "object",
        properties: {
          problem: { type: "string", description: "What is wrong or what must be decided. Be specific and concrete." },
          tried: { type: "string", description: "What you already investigated and what it ruled out. This is what stops the next agent repeating your work." },
          files: { type: "array", items: { type: "string" }, description: "Relevant paths, ideally as path:line, most important first." },
          question: { type: "string", description: "The single specific question or decision you need answered." },
        },
        required: ["problem", "tried", "question"],
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: (args, tctx) =>
        S().escalateImpl(args, {
          agent: tctx.agent,
          sessionID: tctx.sessionID,
          directory,
          ask: v2Ask(tctx),
          signal: tctx.signal,
        }).then(v2Result),
    });

    editor.add({
      name: "work_order",
      description:
        "Work orders from the seat layer. Seats drop validated briefs in " +
        ".fusion/inbox/; 'list' shows pending work, 'accept' claims one and " +
        "returns the brief, 'report' writes the result envelope to " +
        ".fusion/outbox/ for the seat to read back.",
      input: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "accept", "report"], description: "list pending orders, accept one by id, or report a result." },
          id: { type: "string", description: "Work-order id (the frontmatter id / inbox filename). Required for accept and report." },
          status: { type: "string", enum: ["completed", "blocked", "needs-decision", "needs-approval"], description: "Result status. Required for report." },
          summary: { type: "string", description: "What was done or what is blocking. Required for report." },
          note: { type: "string", description: "For needs-decision / needs-approval: the exact question or authorization the seat must answer." },
        },
        required: ["action"],
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: (args, tctx) =>
        S().workOrderImpl(args, {
          agent: tctx.agent,
          sessionID: tctx.sessionID,
          directory,
        }).then(v2Result),
    });

    // Enforce-mode landing pad. A gated call is redirected here by the
    // execute.before hook (event.tool rewrite); it returns the gate reason as
    // ordinary output so the step survives and the model sees the refusal.
    editor.add({
      name: "fusion_blocked",
      description:
        "Internal fusion routing sink: tool calls refused by the evidence " +
        "controller land here instead of running. Do not call this directly.",
      input: { type: "object", additionalProperties: true },
      options: { codemode: false },
      execute: (input) => ({
        content: `[fusion routing] blocked \`${input?.tool ?? "?"}\` call: ${input?.reason ?? "policy"}`,
        metadata: { blockedTool: input?.tool, reason: input?.reason },
      }),
    });
  });

  // ----------------------------------------------------- session hooks

  // Sampling is tuned on the server (the llama-server unit, or Strata's
  // config "sampling": temp 1.0 / top_p 0.95 / top_k 20 / min_p 0.0).
  // Don't fight it from here.
  const stripSampler = (options) => {
    if (!options || typeof options !== "object") return;
    delete options.temperature;
    delete options.topP;
    delete options.topK;
  };

  // Merge reasoning_effort into a request body's chat_template_kwargs (both
  // llama.cpp and Strata read it there). Returns false when there is no
  // effort to send.
  const stampEffort = (json, want) => {
    if (!want) return false;
    json.chat_template_kwargs = {
      ...(json.chat_template_kwargs && typeof json.chat_template_kwargs === "object" ? json.chat_template_kwargs : {}),
      reasoning_effort: want,
    };
    return true;
  };
  const rebuildRequest = (req, json) => {
    const headers = new Headers(req.headers);
    headers.delete("content-length"); // stale length would truncate the new body
    return new Request(req.url, { method: req.method, headers, body: JSON.stringify(json) });
  };

  // Eviction guard. Fires once per model call (primary, compaction, title,
  // generate), scoped to llamacpp. The resident model is shared state; a
  // stray model name unloads it and kills whatever it was generating.
  // Strata needs no guard: it answers every model name with its one model.
  // Residency is read live from /v1/models (never the load-time snapshot):
  // the model can change under a running server, and a server that was
  // down at load still gets checked the moment it answers. The wire name
  // is resolved from the config files (cfgWireIds): aliases declare the
  // "local" placeholder that the http.request hook rewrites to the
  // resident id, and only a genuinely non-resident name is a violation.
  registrations.push(await ctx.session.hook("model.request", async (event) => {
    const { profile, llamaBase, unit, readResidentLive, cfgWireIds } = S();
    if (profile.guard === "off") return;
    const baseURL = event.baseURL ?? llamaBase ?? `http://127.0.0.1:${unit.port ?? 8080}`;
    const ids = await readResidentLive(baseURL, event.headers);
    const residentList = ids && ids.size ? [...ids].join(", ") : "none";
    if (!ids || !ids.size) {
      // Unreachable is also the backend-down signal: mark it so sidekick
      // seats reroute and the TUI hears about it once.
      if (!ids) markBackend("llamacpp", true, "unreachable or unauthorized");
      throw new Error(
        `[fusion] no resident model readable at ${baseURL}/v1/models ` +
        `(server ${ids ? "has nothing loaded" : "unreachable or unauthorized"}). ` +
        `Refusing the llamacpp request rather than guessing a wire name.`,
      );
    }
    const declared = cfgWireIds.get(String(event.model.id)) ?? String(event.model.id);
    if (declared === "local") {
      // The placeholder resolves to a resident id on the wire below, but
      // only when the pin itself is resident or absent; a stale pin names
      // a model that would evict the resident one.
      if (profile.local_model && !ids.has(profile.local_model)) {
        throw new Error(
          `[fusion] pinned local_model "${profile.local_model}" is not resident (resident: ${residentList}). ` +
          `Refusing: it would evict the resident model. Update local_model in fusion.jsonc or unload the pin.`,
        );
      }
      return;
    }
    if (ids.has(declared)) return;
    const msg =
      `[fusion] "${declared}" is not resident (resident: ${residentList}). ` +
      `llama-server runs --models-max ${unit.modelsMax ?? 1}, so naming it would unload the resident model mid-flight.`;
    if (profile.guard === "strict") {
      throw new Error(`${msg} Refusing: set "guard": "warn" in fusion.jsonc to allow.`);
    }
    console.error(`${msg} Allowing because guard is "warn"; the wire rewrite sends the resident id instead.`);
  }, { providerID: "llamacpp" }));

  // The wire stamp. Aliases declare modelID "local" and plugin transforms
  // cannot beat the post-phase config builtin, so the resolved wire id is
  // rewritten at the last point of control: the serialized request body.
  // chat_template_kwargs rides the same rewrite for the same reason. The
  // hook is scoped to llamacpp by the provider filter and self-guards by
  // URL so a mis-scoped request can never pick up a local wire id.
  registrations.push(await ctx.session.hook("http.request", async (event) => {
    const { profile, unit, readResidentLive, pickWireId, cfgWireIds, effortFor } = S();
    const req = event.request;
    if (!req?.body) return;
    // Only requests that target the llama-server port are rewritten. When
    // the unit's port is unreadable the provider filter remains the guard.
    if (unit.port && new URL(req.url).port !== String(unit.port)) return;
    let json;
    try {
      json = JSON.parse(await req.clone().text());
    } catch {
      return; // not JSON: not a chat request, leave it alone
    }
    if (!json || typeof json !== "object" || Array.isArray(json)) return;
    if (typeof json.model === "string") {
      const ids = await readResidentLive(new URL(req.url).origin, req.headers);
      const wireId = pickWireId(ids);
      if (!wireId) {
        throw new Error(
          `[fusion] no resident model readable at ${new URL(req.url).origin}/v1/models ` +
          `(pin: ${profile.local_model ?? "none"}). Refusing to send "${json.model}": ` +
          `a non-resident name would evict the loaded model.`,
        );
      }
      const declared = cfgWireIds.get(json.model);
      if (declared && ids.has(declared)) json.model = declared;
      else if (!ids.has(json.model)) json.model = wireId;
      // else the body already names a resident id; leave it.
    }
    stampEffort(json, effortFor(event.agent, "llamacpp"));
    event.request = rebuildRequest(req, json);
  }, { providerID: "llamacpp" }));

  // Strata gets the per-agent effort and nothing else: it serves one model
  // and answers every name with it, so there is no wire id to rewrite and
  // nothing to evict. Scoped by provider only, because Strata's port is
  // whatever opencode.jsonc says.
  registrations.push(await ctx.session.hook("http.request", async (event) => {
    const req = event.request;
    if (!req?.body) return;
    let json;
    try {
      json = JSON.parse(await req.clone().text());
    } catch {
      return; // not JSON: not a chat request, leave it alone
    }
    if (!json || typeof json !== "object" || Array.isArray(json)) return;
    if (!stampEffort(json, S().effortFor(event.agent, "strata"))) return;
    event.request = rebuildRequest(req, json);
  }, { providerID: "strata" }));

  // Local backend error visibility. A 400 the TUI would only ever show as
  // "step failed" gets decoded once: context overflow gets its own action,
  // everything else is reported as a backend error. The hook is the
  // fire-and-forget observer kind (it must return nothing), so the notice
  // lands through emitNotice, not by throwing.
  for (const providerID of LOCAL_PROVIDERS) {
    registrations.push(await ctx.session.hook("http.response", async (event) => {
      const res = event.response;
      if (!res || res.status < 400) return;
      const name = providerID === "strata" ? "Strata" : "llama-server";
      const body = await res.clone().text().catch(() => "");
      const blob = `${res.status} ${body}`.slice(0, 400);
      if (res.status === 400 && /context|tokens?|too (long|large)|exceed|maximum/i.test(blob)) {
        emitNotice(
          "context-400",
          `${name} refused the request: the prompt plus the reply budget did not fit the context.`,
          "Compact the session, shorten the last request, or lower the model's output limit.",
          { sessionID: event.sessionID },
        );
      } else {
        emitNotice(
          "backend-error",
          `${name} answered HTTP ${res.status}: ${body.trim().slice(0, 140) || "no details"}.`,
          providerID === "strata"
            ? "Check the Strata server, or switch the sidekick with /fusion sidekick."
            : "Check llama-server, or switch the sidekick with /fusion sidekick.",
          { severity: "error", sessionID: event.sessionID },
        );
      }
    }, { providerID }));
  }

  // v1 compaction.prune parity: shrink stale tool outputs in the assembled
  // context before they reach the model. Only active when the config still
  // declares the v1 flag; on v2 it is what makes the key true rather than
  // dead. Error results and the newest protectTail characters stay whole.
  if (configAudit.pruneEnabled) {
    registrations.push(await ctx.session.hook("context", (event) => {
      const n = pruneOldToolOutputs(event.messages);
      if (n) logControl({ kind: "prune", session: event.sessionID, results: n });
    }));
  }

  // A down local backend makes every retry burn time for nothing. Refuse
  // retries aimed at it; the seat already rerouted or the error says why.
  registrations.push(await ctx.session.hook("retry", (event) => {
    const providerID = event.model?.providerID;
    if (providerID && backendDown[providerID]) {
      event.decision = { retry: false };
    }
  }));

  // The sampler strip covers every local request kind. (chat.params fired
  // for all of them in v1; v2 splits request construction per kind.)
  for (const providerID of LOCAL_PROVIDERS) {
    for (const name of ["context", "generate", "title"]) {
      registrations.push(await ctx.session.hook(name, (event) => {
        stripSampler(event.options);
      }, { providerID }));
    }
  }

  // Compaction is exactly where "two honest attempts" used to die: the retry
  // history lived in scrollback that pruning removes. Inject the measured
  // state into the compaction system prompt so the post-compaction summary
  // carries the counters, not a memory of them. Runs for every provider:
  // the controller tracks harness state, not llamacpp state.
  registrations.push(await ctx.session.hook("compaction", (event) => {
    const { profile } = S();
    if (LOCAL_PROVIDERS.includes(event.model?.providerID)) stripSampler(event.options);
    event.system.push({
      type: "text",
      text: renderControllerState(ctrl, {
        stallEdits: profile.stall_edits,
        stallCommands: profile.stall_commands,
        scopeLimit: profile.grunt_max_blast,
      }),
    });
    const orders = readOrders().orders;
    const open = Object.entries(orders).filter(([, o]) => o.status === "in_progress");
    if (open.length) {
      event.system.push({
        type: "text",
        text:
          `[fusion work orders in progress: ${open.map(([id, o]) => `${id} (from ${o.seat ?? "?"})`).join(", ")}. ` +
          `Report results with the work_order tool.]`,
      });
    }
  }));

  // -------------------------------------------------------- tool hooks

  // Pending entries per callID. Codemode/batch inner calls share the parent
  // callID, so the value is a FIFO queue; takePending matches by entry kind
  // (cmd|file) and value where derivable.
  const pushPending = (id, entry) => {
    const q = ctrl.pending.get(id) ?? [];
    q.push(entry);
    ctrl.pending.set(id, q);
    if (ctrl.pending.size > 500) ctrl.pending.delete(ctrl.pending.keys().next().value);
  };
  const takePending = (id, kind, match) => {
    const q = ctrl.pending.get(id);
    if (!q) return null;
    let i = q.findIndex((e) => kind in e && (match === undefined || e[kind] === match));
    if (i < 0) i = q.findIndex((e) => kind in e);
    if (i < 0) i = 0;
    const [entry] = q.splice(i, 1);
    if (!q.length) ctrl.pending.delete(id);
    return entry ?? null;
  };
  const queueNotice = (id, text) => {
    const q = ctrl.notices.get(id) ?? [];
    q.push(text);
    ctrl.notices.set(id, q);
    if (ctrl.notices.size > 200) ctrl.notices.delete(ctrl.notices.keys().next().value);
  };

  // One decision path for every gate: enforce redirects the call to
  // fusion_blocked (it never runs and the agent gets the reason as output);
  // observe queues a notice that the after-hook appends. Either way logged.
  const gateV2 = (event, kind, reason, extra = {}) => {
    const { profile } = S();
    logControl({ kind: profile.routing === "enforce" ? `${kind}-blocked` : `${kind}-observed`, ...extra, reason });
    if (profile.routing === "enforce") {
      event.input = { reason, tool: event.tool, args: event.input };
      event.tool = "fusion_blocked";
      return;
    }
    queueNotice(event.id, `[fusion routing: observe] would block: ${reason}`);
  };

  // Evidence routing, gate side. Fusion.js sorts before rtk.ts in the
  // auto-scanned plugin directory, so recorded commands are what the model
  // asked for, not the compressed equivalent.
  registrations.push(await ctx.tool.hook("execute.before", async (event) => {
    const { profile } = S();
    const agent = String(event.agent ?? "fusion");
    const args = event.input && typeof event.input === "object" ? event.input : {};

    if (event.tool === "subagent" || event.tool === "task") {
      const to = args.agent ?? args.subagent_type ?? "?";
      logControl({ kind: "dispatch", session: event.sessionID, agent, to, desc: String(args.description ?? "").slice(0, 120) });
      // The oracle is parked unless escalation is explicitly "fable". The
      // registry cannot remove it (config re-adds it after this plugin's
      // transform), so the gate is what actually keeps paid calls opt-in.
      if (profile.escalation !== "fable" && to === "oracle") {
        gateV2(
          event,
          "oracle-parked",
          `the oracle agent is parked (escalation "${profile.escalation}" keeps paid calls opt-in). ` +
            "Use the escalate tool to hand the problem to Claude Code instead.",
          { to },
        );
      }
      return;
    }

    if (event.tool === "shell" || event.tool === "bash") {
      const cmd = normalizeCommand(args.command);
      pushPending(event.id, { cmd, agent });
      const reason = gateCommand(ctrl, cmd, profile.stall_commands);
      if (reason) gateV2(event, "cmd-stall", reason, { cmd });
      return;
    }

    const file = extractFilePath(event.tool, args);
    if (file) {
      const rel = path.relative(directory, path.resolve(directory, file)) || file;
      pushPending(event.id, { file: rel, agent });
      const isSidekick = agent !== "fusion" && agent !== "oracle";

      const reason = gateEdit(ctrl, rel, agent, {
        stallEdits: profile.stall_edits,
        protectedPaths: profile.protected_paths,
        scopeLimit: profile.grunt_max_blast,
      });
      if (reason) return gateV2(event, "edit-stall", reason, { file: rel, agent });

      // Up-front blast radius on a sidekick's first touch of each file.
      // Unknown (no graft index, unindexed file) is recorded, never blocked.
      if (isSidekick && profile.scope_check && hasGraft() && !fileScope.has(rel)) {
        const deps = await measureFileScope(rel);
        fileScope.set(rel, { deps, ts: Date.now() });
        logControl({ kind: "scope-file", file: rel, agent, deps });
        if (deps != null && deps > profile.grunt_max_blast) {
          return gateV2(
            event,
            "scope-file",
            `"${rel}" has ${deps} dependent files (limit ${profile.grunt_max_blast} for the sidekick tier). ` +
              `This surface moves to the lead.`,
            { file: rel, agent, deps },
          );
        }
      }
    }
  }));

  const contentText = (content) =>
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.filter((p) => p?.type === "text").map((p) => p.text).join("\n")
        : "";

  registrations.push(await ctx.tool.hook("execute.after", async (event) => {
    const { profile, localSummarize } = S();
    const toolName = event.tool;

    // A gated call: drain its pending entry without counting (it never ran),
    // and never feed the refusal text into compression. The after event's
    // input is the redirected {reason, tool, args}, so the original tool and
    // arguments are recoverable for a surgical queue match.
    if (toolName === "fusion_blocked") {
      const origTool = event.input?.tool;
      const origArgs = event.input?.args ?? {};
      const origFile = extractFilePath(origTool, origArgs);
      const kind = origTool === "shell" || origTool === "bash" ? "cmd" : origFile ? "file" : "cmd";
      const match = kind === "file" && origFile
        ? path.relative(directory, path.resolve(directory, origFile)) || origFile
        : normalizeCommand(origArgs.command);
      takePending(event.id, kind, match || undefined);
      return;
    }

    // ---- evidence routing, outcome side ---------------------------
    // Consume what the before-hook recorded for this call, update the
    // counters, then append any queued notice so the agent sees it.
    const kind = toolName === "shell" || toolName === "bash" ? "cmd" : "file";
    const match = kind === "file"
      ? (() => { const f = extractFilePath(toolName, event.input ?? {}); return f ? path.relative(directory, path.resolve(directory, f)) || f : undefined; })()
      : undefined;
    const pending = takePending(event.id, kind, match);
    if (event.status !== "completed") return;
    const result = event.result;
    let text = contentText(result?.content);
    if (!result) return;

    const agent = String(event.agent ?? "");

    if (pending?.cmd) {
      const exit = result.metadata?.exit;
      const timeout = result.metadata?.timeout === true;
      const failed = (typeof exit === "number" && exit !== 0) || timeout;
      if (failed) {
        const sig = failSignature(text, exit, timeout);
        const f = recordCommandResult(ctrl, pending.cmd, false, sig);
        logControl({ kind: "cmd-fail", session: event.sessionID, agent: pending.agent, cmd: pending.cmd, exit, sig, n: f.n });
        if (f.n >= profile.stall_commands - 1) {
          result.content =
            `${text}\n\n[fusion] This command has now failed ${f.n} time(s) in a row ` +
            `(signature: ${sig}). At ${profile.stall_commands} identical retries are ` +
            `${profile.routing === "enforce" ? "blocked" : "flagged"}. Change the approach ` +
            `or escalate with what the failures ruled out.`;
        }
      } else {
        recordCommandResult(ctrl, pending.cmd, true);
        if (isVerificationCommand(pending.cmd)) {
          recordVerification(ctrl, pending.cmd, exit ?? 0);
          logControl({ kind: "check", session: event.sessionID, agent: pending.agent, cmd: pending.cmd, exit });
        }
      }
    }
    if (pending?.file) {
      const e = recordEdit(ctrl, pending.file, pending.agent);
      logControl({ kind: "edit", session: event.sessionID, agent: pending.agent, file: pending.file, n: e.n });

      // Post-edit scope on the real diff. Debounced: blast runs at most
      // every 3rd sidekick edit, since early edits rarely settle the
      // radius. Runs after the edit lands so the measurement is real.
      if (
        profile.scope_check && hasGraft() && !ctrl.scope.exceeded &&
        pending.agent !== "fusion" && pending.agent !== "oracle" &&
        blastTick() % 3 === 0
      ) {
        const diff = await measureDiffScope();
        if (diff && diff.impacted > profile.grunt_max_blast) {
          ctrl.scope.exceeded = true;
          ctrl.scope.impacted = diff.impacted;
          ctrl.scope.files = diff.files;
          logControl({ kind: "scope-diff", impacted: diff.impacted, files: diff.files.slice(0, 20), limit: profile.grunt_max_blast });
          result.content =
            `${text}\n\n[fusion] Working-diff blast radius is now ${diff.impacted} files ` +
            `(limit ${profile.grunt_max_blast} for the sidekick tier)` +
            `${profile.routing === "enforce" ? " - further sidekick edits are blocked" : " - would gate sidekick edits"}. ` +
            `The lead takes the remaining edits, or narrow the scope.`;
        }
      }
    }

    const notes = ctrl.notices.get(event.id);
    if (notes?.length) {
      ctrl.notices.delete(event.id);
      result.content = `${contentText(result.content)}\n\n${notes.join("\n")}`;
    }
    // The evidence block may have rewritten result.content; the compression
    // path below works on what is actually there now.
    text = contentText(result.content);
    // ---------------------------------------------------------------

    // Let the free local model compress oversized tool output before it lands
    // in a paid context. Head and tail are kept verbatim so nothing the model
    // needs to quote exactly is silently lost.
    if (!agent || agent === "scout" || agent === "grunt" || agent === "critic") return;
    if (["todowrite", "task", "subagent", "question"].includes(toolName)) return;

    // v2 truncates tool output AFTER this hook, so the marker below cannot
    // appear here. It is kept for the v1 code path and in case a tool writes
    // the phrase itself; the compression branch is what fires on v2.
    const saved = /Full output saved to:\s*(\S+)/.exec(text);
    if (saved) {
      result.content =
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
      const summary = await localSummarize({ tool: toolName, middle });
      if (!summary) return;
      result.content =
        `${head}\n\n` +
        `[fusion: ${middle.length} chars of the middle were summarized by the local model. ` +
        `Ask scout to read the source if you need the exact text.]\n\n` +
        `${summary}\n\n` +
        `[end of summary; final 1000 chars verbatim]\n\n${tail}`;
    } catch (e) {
      // Compression is an optimization. Never let it break the tool call.
      console.error(`[fusion] tool-output compression skipped: ${e.message}`);
    }
  }));

  // -------------------------------------------------------- the /fusion RPC
  //
  // The TUI plugin (plugins/fusion/tui.tsx) renders the control surface and
  // this is its read/write channel. status composes the panel, live backend
  // health, accounting and the config audit. set writes one knob back to the
  // profile file and applies it live; choices feeds the pickers.
  const buildStatus = async (sessionID) => {
    const f = S();
    const { profile } = f;
    for (const p of LOCAL_PROVIDERS) {
      if (localSeatsUse(p)) await checkBackend(p);
    }
    let strataLive = null;
    if (f.sidekickIsStrata || f.providerOf(f.criticPatch.model) === "strata") {
      try {
        const res = await fetch(`${f.strataBase}/health`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          const h = await res.json();
          strataLive = { model: h.model ?? null, maxContext: h.max_context ?? null, loaded: h.loaded ?? null };
        }
      } catch {
        /* unreachable: health[p] already says so */
      }
    }
    const usageFile = path.join(fusionDir, "usage.jsonl");
    const session = usageTotals(readUsageRows(usageFile, sessionID || undefined), profile.base);
    const totals = usageTotals(readUsageRows(usageFile), profile.base);
    const rtkInstalled = (() => {
      try {
        return spawnSync("rtk", ["--version"], { stdio: "ignore" }).status === 0;
      } catch {
        return false;
      }
    })();
    const activeFallback =
      profile.sidekick_fallback && LOCAL_PROVIDERS.some((p) => backendDown[p] && localSeatsUse(p))
        ? SIDEKICKS[profile.sidekick_fallback] ?? null
        : null;
    return {
      banner: f.banner,
      profile: {
        base: profile.base,
        sidekick: profile.sidekick,
        critic: profile.critic,
        reasoning: profile.reasoning,
        speed: profile.speed,
        escalation: profile.escalation,
        guard: profile.guard,
        routing: profile.routing,
        sidekick_fallback: profile.sidekick_fallback ?? null,
        local_efforts: profile.local_efforts ?? {},
        local_model: profile.local_model ?? null,
        local_ctx: profile.local_ctx ?? null,
      },
      resolved: {
        lead: `${f.leadModel}${f.leadEffort ? ` (${f.leadEffort})` : ""}`,
        sidekick: f.sidekick,
        critic: `${f.criticPatch.model}${f.criticPatch.variant ? ` (${f.criticPatch.variant})` : ""}`,
        oracle: profile.escalation === "fable" ? `${f.oracleBase.model} (${f.oracleEffort})` : "parked",
      },
      backend: {
        llamacpp: {
          url: f.llamaBase ?? (f.unit.port ? `http://127.0.0.1:${f.unit.port}` : null),
          remote: f.remote,
          down: backendDown.llamacpp,
          up: health.llamacpp.ok === true,
          used: localSeatsUse("llamacpp"),
          resident: f.localWireId ? [f.localWireId] : [],
          ctx: f.unit.ctx ?? null,
          parallel: f.unit.parallel ?? null,
        },
        strata: {
          url: f.strataBase,
          down: backendDown.strata,
          up: health.strata.ok === true,
          used: localSeatsUse("strata"),
          live: strataLive,
        },
        fallback: { name: profile.sidekick_fallback ?? null, active: activeFallback },
      },
      graft: { present: f.hasGraft() },
      rtk: { installed: rtkInstalled },
      stalls: f.stallsSummary(),
      session: sessionID
        ? { id: sessionID, cost: session.totalCost, shadowCost: session.shadowCost, freeLead: session.freeLead, agents: session.byAgent }
        : null,
      totals: { cost: totals.totalCost, shadowCost: totals.shadowCost, freeLead: totals.freeLead },
      dropped: { audited: configAudit.audited, unaudited: configAudit.unaudited },
      pruneActive: configAudit.pruneEnabled,
    };
  };

  const runDoctor = () =>
    new Promise((resolve) => {
      let child;
      try {
        child = spawn("bash", [graftBin, "doctor"], { cwd: directory, stdio: ["ignore", "pipe", "pipe"] });
      } catch (e) {
        return resolve(`oc-fusion doctor could not start: ${e.message}`);
      }
      let out = "";
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        resolve(`${out}\n[doctor timed out after 45s]`);
      }, 45_000);
      child.stdout.on("data", (d) => {
        out += d;
      });
      child.stderr.on("data", (d) => {
        out += d;
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve(`oc-fusion doctor could not start: ${e.message}`);
      });
      child.on("close", () => {
        clearTimeout(timer);
        resolve(out.trim() || "doctor produced no output");
      });
    });

  try {
    const rpcReg = await ctx.rpc.register(FUSION_RPC, {
      status: async ({ sessionID } = {}) => buildStatus(sessionID),
      choices: async ({ key } = {}) => {
        const { profile } = S();
        if (key === "effort") {
          const current = profile.local_efforts ?? {};
          return {
            key,
            label: "Local effort per seat",
            help: "reasoning_effort sent to llama.cpp or Strata per agent. Must be a level the model's chat template accepts.",
            seats: EFFORT_SEATS.map((seat) => ({
              seat,
              current: current[seat] ?? "medium",
              options: EFFORT_LEVELS.map((v) => ({ value: v, title: v })),
            })),
          };
        }
        const knob = KNOBS[key];
        if (!knob) {
          return {
            key,
            error: `"/fusion ${key}" is not a control. Valid: ${["status", "effort", "doctor", "help", ...Object.keys(KNOBS)].join(", ")}.`,
          };
        }
        return {
          key,
          label: knob.label,
          help: knob.help,
          current: profile[knob.write],
          options: knob.options(BASES, SIDEKICKS),
        };
      },
      set: async ({ key, value } = {}, callCtx) => {
        const file = S().profileFile;
        if (!file) {
          return callCtx.error("no-profile", "No fusion.jsonc is in effect (defaults only). Create one first, then retry.");
        }
        if (String(key).startsWith("local_efforts.")) {
          const seat = String(key).split(".")[1];
          if (!EFFORT_SEATS.includes(seat)) {
            return callCtx.error("bad-key", `Unknown effort seat "${seat}". Seats: ${EFFORT_SEATS.join(", ")}.`);
          }
          if (!EFFORT_LEVELS.includes(value)) {
            return callCtx.error("bad-value", `"${value}" is not a level. Levels: ${EFFORT_LEVELS.join(", ")}.`);
          }
          if (!writePanelEffort(file, seat, value)) {
            return callCtx.error("write-failed", `Could not write "${seat}" into "local_efforts" in ${file}.`);
          }
          await refresh();
          void ctx.agent.reload?.().catch?.(() => {});
          emitNotice("profile-set", `${seat} effort is now "${value}".`, "It applies to the next local request.", {
            severity: "info",
          });
          return { applied: true, key, value, file };
        }
        const knob = KNOBS[String(key)];
        if (!knob) {
          return callCtx.error("bad-key", `"${key}" is not a control. Valid: ${Object.keys(KNOBS).join(", ")}.`);
        }
        const valid = knob.options(BASES, SIDEKICKS).map((o) => o.value);
        if (!valid.includes(value)) {
          return callCtx.error("bad-value", `"${value}" is not a valid ${knob.label.toLowerCase()}. Valid: ${valid.join(", ")}.`);
        }
        if (!writePanelKey(file, knob.write, value)) {
          return callCtx.error(
            "write-failed",
            `Could not write "${knob.write}" into ${file}: the key is missing. Add it once, then /fusion can set it.`,
          );
        }
        await refresh();
        void ctx.agent.reload?.().catch?.(() => {});
        void ctx.model.reload?.().catch?.(() => {});
        const note =
          key === "sidekick" && /^strata/.test(String(value))
            ? "The remote Strata model swap only runs through `oc-fusion sidekick` on the box."
            : null;
        emitNotice("profile-set", `${knob.label} is now "${value}".`, note ?? "It applies to the next request.", {
          severity: "info",
        });
        return { applied: true, key, value, file, note };
      },
      doctor: async () => ({ text: await runDoctor() }),
      notices: async () => {
        drainPendingFile();
        return { items: notices.list() };
      },
    });
    rpcEvents = rpcReg.events;
    registrations.push(rpcReg);
  } catch (e) {
    console.error(`[fusion] RPC registration failed (${e.message}); /fusion controls are unavailable on this host`);
  }

  // ------------------------------------------------- usage accounting
  //
  // v2 step events carry what v1 reconstructed: session.step.started has
  // agent+model, session.step.ended has the final tokens+cost. One line per
  // step (one model call). Title/compaction aux usage arrives as
  // session.usage.recorded and is logged under the source name.
  const stepMeta = new Map(); // assistantMessageID -> {session, agent, model}
  const seenSteps = new Set();
  const usageCtl = new AbortController();
  const usageLoop = (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: usageCtl.signal })) {
        if (event.type === "session.step.started") {
          stepMeta.set(event.assistantMessageID, {
            session: event.sessionID,
            agent: event.agent,
            model: event.model,
          });
          if (stepMeta.size > 2000) {
            const it = stepMeta.keys();
            for (let i = 0; i < 1000; i++) {
              const r = it.next();
              if (r.done) break;
              stepMeta.delete(r.value);
            }
          }
          continue;
        }
        if (event.type === "session.step.ended" || event.type === "session.step.failed") {
          const meta = stepMeta.get(event.assistantMessageID) ?? {};
          const t = event.tokens ?? {};
          const key = `${event.assistantMessageID}:${event.finish ?? "err"}:${t.input}:${t.output}:${event.cost}`;
          if (seenSteps.has(key)) continue;
          seenSteps.add(key);
          // Failure notices the TUI would otherwise never decode. Dedup is
          // inside emitNotice; each kind fires once per distinct message.
          const prov = meta.model?.providerID;
          if (event.type === "session.step.ended" && LOCAL_PROVIDERS.includes(prov)
              && event.finish === "length" && (t.reasoning ?? 0) > 0) {
            emitNotice(
              "thinking-truncated",
              `${prov === "strata" ? "Strata" : "The local model"} spent its whole reply budget on thinking and stopped without an answer.`,
              "Send the last request again, or lower the seat's effort in /fusion effort.",
              { sessionID: meta.session ?? event.sessionID },
            );
          }
          if (event.type === "session.step.failed" && LOCAL_PROVIDERS.includes(prov)) {
            const err = event.error ?? {};
            const blob = `${err.message ?? ""} ${err.response?.body ?? ""}`;
            if (err.status === 400 && /context|tokens?|too (long|large)|exceed|maximum/i.test(blob)) {
              emitNotice(
                "context-400",
                `${prov === "strata" ? "Strata" : "The local model"} refused the request: the prompt plus the reply budget did not fit the context.`,
                "Compact the session, shorten the last request, or lower the model's output limit.",
                { sessionID: meta.session ?? event.sessionID },
              );
            } else if (!err.status && /fetch|econn|enotfound|etimedout|socket|network|unreachable|connect|refused/i.test(blob)) {
              markBackend(prov, true, String(err.message ?? "connection failed").slice(0, 120));
            }
          }
          if (seenSteps.size > 4000) {
            const it = seenSteps.values();
            for (let i = 0; i < 2000; i++) {
              const r = it.next();
              if (r.done) break;
              seenSteps.delete(r.value);
            }
          }
          appendUsage({
            ts: new Date().toISOString(),
            session: meta.session ?? event.sessionID,
            message: event.assistantMessageID,
            agent: meta.agent ?? "unknown",
            model: meta.model ? `${meta.model.providerID}/${meta.model.id}` : "unknown",
            in: t.input ?? 0,
            out: t.output ?? 0,
            reasoning: t.reasoning ?? 0,
            cache_read: t.cache?.read ?? 0,
            cache_write: t.cache?.write ?? 0,
            cost: event.cost ?? 0,
            error: event.type === "session.step.failed" ? (event.error?.name ?? event.error?.type ?? "failed") : undefined,
          });
          continue;
        }
        if (event.type === "session.usage.recorded") {
          const t = event.tokens ?? {};
          appendUsage({
            ts: new Date().toISOString(),
            session: event.sessionID,
            agent: event.source ?? "aux",
            model: "(aux)",
            in: t.input ?? 0,
            out: t.output ?? 0,
            reasoning: t.reasoning ?? 0,
            cache_read: t.cache?.read ?? 0,
            cache_write: t.cache?.write ?? 0,
            cost: event.cost ?? 0,
          });
        }
      }
    } catch (e) {
      if (!usageCtl.signal.aborted) console.error(`[fusion] event subscription failed: ${e.message}`);
    }
  })();
  void usageLoop;

  // Plugin unload cleanup: close the event stream, the health probe timer
  // and drop registrations.
  return () => {
    clearInterval(healthTimer);
    usageCtl.abort();
    for (const r of registrations) void r?.dispose?.();
  };
};

export default {
  id: "fusion",
  server,
  setup: setupV2,
};
