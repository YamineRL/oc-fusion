// Shared, host-free pieces of the fusion control surface: the RPC contract
// between the server plugin and the TUI plugin, the control-panel writer,
// the valid choices per knob, the pending-notice store, the list of config
// keys opencode v2 drops, and the usage-accounting math. Everything here is
// a pure function on plain data so tests can cover it without an opencode
// host.

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------- RPC ----

// Plain JSON schemas (draft 2020-12) on both ends: neither plugin file has
// to import @opencode/schema. The TUI builds its client from this same
// object, so the contract cannot drift between the two halves.
const anyOf = (list) => ({ anyOf: list });
const obj = (properties, extra = {}) => ({ type: "object", properties, additionalProperties: false, ...extra });
const str = (extra = {}) => ({ type: "string", ...extra });
const bool = () => ({ type: "boolean" });

export const FUSION_RPC = {
  id: "fusion",
  methods: {
    // The full status snapshot the /fusion status dialog renders.
    status: {
      input: obj({ sessionID: str() }),
      output: obj({}, { additionalProperties: true }),
    },
    // Re-read every provider's model list into the cache the base picker uses.
    models: {
      input: obj({}),
      output: obj({}, { additionalProperties: true }),
    },
    // Valid values for one knob, with the current one marked.
    choices: {
      input: obj({ key: str() }, { required: ["key"] }),
      output: obj({}, { additionalProperties: true }),
    },
    // Write one knob to fusion.jsonc and apply it live. value is the new
    // value (string/number/boolean/null, or a dotted local_efforts.<seat>
    // key with a level string).
    set: {
      input: obj({ key: str(), value: anyOf([str(), { type: "number" }, bool(), { type: "null" }]) }, { required: ["key", "value"] }),
      output: obj({}, { additionalProperties: true }),
    },
    // `oc-fusion doctor` output, run read-only.
    doctor: {
      input: obj({}),
      output: obj({ text: str() }, { additionalProperties: true }),
    },
    // Notices queued before the TUI subscribed (and file-drained ones).
    notices: {
      input: obj({}),
      output: obj({ items: { type: "array", items: obj({}, { additionalProperties: true }) } }, { additionalProperties: true }),
    },
  },
  events: {
    notice: {
      schema: obj(
        {
          id: str(),
          kind: str(),
          severity: str({ enum: ["info", "warning", "error"] }),
          title: str(),
          message: str(),
          action: str(),
          sessionID: str(),
        },
        { required: ["id", "kind", "message"], additionalProperties: true },
      ),
    },
  },
};

// ---------------------------------------------------------- lead models --

// Providers that run on the owner's own hardware (no per-token cost).
const LOCAL_LEAD_PROVIDERS = ["llm-swap", "strata", "llamacpp"];

// Effort ladder for a lead given as a raw provider/model id. The gateway
// publishes no levels for new models, so this goes by vendor.
export function vendorEfforts(model) {
  const m = String(model).toLowerCase();
  if (/anthropic|claude/.test(m)) return ["low", "medium", "high", "xhigh", "max"];
  if (/openai|gpt-/.test(m)) return ["none", "low", "medium", "high", "xhigh", "max"];
  if (/zai|glm|moonshot|kimi/.test(m)) return ["low", "high", "max"];
  return [];
}

// A lead is an alias from `bases` or any "provider/model" id. Returns
// { model, efforts, free? } or null.
export function resolveBase(spec, bases) {
  if (typeof spec !== "string" || !spec) return null;
  if (bases[spec]) return bases[spec];
  if (!/^[^/\s]+\/\S+$/.test(spec)) return null;
  return { model: spec, efforts: vendorEfforts(spec), free: /^opencode\/.*-free$/.test(spec) };
}

// opencode's own favourites and recents (the model picker state file).
export function readModelState(file) {
  const f =
    file ??
    path.join(process.env.XDG_STATE_HOME || path.join(process.env.HOME || "", ".local/state"), "opencode/model.json");
  try {
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    const ids = (list) =>
      (Array.isArray(list) ? list : [])
        .filter((m) => m?.providerID && m?.modelID)
        .map((m) => `${m.providerID}/${m.modelID}`);
    return { favorite: ids(j.favorite), recent: ids(j.recent) };
  } catch {
    return { favorite: [], recent: [] };
  }
}

function leadFooter(model, free) {
  if (free) return "free";
  return LOCAL_LEAD_PROVIDERS.includes(String(model).split("/")[0]) ? "local" : "paid";
}

// Every model of every connected provider, as opencode's server lists it
// (GET /api/model). Cached on disk: the picker reads the cache, and
// `/fusion models` refreshes it.
const xdg = (k, d) => process.env[k] || path.join(process.env.HOME || "", d);
export const MODEL_CACHE = path.join(xdg("XDG_CACHE_HOME", ".cache"), "oc-fusion/models.json");
const SERVICE_FILE = path.join(xdg("XDG_STATE_HOME", ".local/state"), "opencode/service.json");

export function readModelCache(file = MODEL_CACHE) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    return { fetched: j.fetched ?? 0, models: Array.isArray(j.models) ? j.models : [] };
  } catch {
    return { fetched: 0, models: [] };
  }
}

// Normalise /api/model rows to { id: "provider/model", cost: [in, out] | null }.
export function catalogRows(body) {
  const list = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
  const out = [];
  for (const m of list) {
    const provider = m?.providerID ?? m?.provider;
    const id = m?.id ?? m?.modelID;
    if (!provider || !id) continue;
    const c = Array.isArray(m.cost) ? m.cost[0] : m.cost;
    const cost = c && typeof c.input === "number" ? [c.input, c.output ?? 0] : null;
    out.push({ id: `${provider}/${id}`, cost });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

export async function refreshModelCache({ directory, serviceFile = SERVICE_FILE, file = MODEL_CACHE, fetchImpl = fetch } = {}) {
  let svc;
  try {
    svc = JSON.parse(fs.readFileSync(serviceFile, "utf8"));
  } catch {
    throw new Error(`no opencode service file at ${serviceFile}`);
  }
  const url = new URL("/api/model", svc.url);
  if (directory) url.searchParams.set("location[directory]", directory);
  const headers = svc.password
    ? { authorization: "Basic " + Buffer.from(`opencode:${svc.password}`).toString("base64") }
    : {};
  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`GET /api/model answered ${res.status}`);
  const models = catalogRows(await res.json());
  if (!models.length) throw new Error("GET /api/model returned no models");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ fetched: Date.now(), models }, null, 1));
  return { count: models.length, providers: new Set(models.map((m) => m.id.split("/")[0])).size };
}

// Picker options: Favourites, Recent (opencode's own lists), then the curated
// leads. A model that has an alias is offered under its alias. No duplicates.
export function baseOptions(bases, state = { favorite: [], recent: [] }, recentMax = 8) {
  const aliasOf = Object.fromEntries(Object.entries(bases).map(([k, b]) => [b.model, k]));
  const seen = new Set();
  const out = [];
  const add = (spec, category) => {
    const value = aliasOf[spec] ?? spec;
    if (seen.has(value)) return;
    const b = resolveBase(value, bases);
    if (!b) return;
    seen.add(value);
    const rate = LEAD_RATES[value];
    out.push({
      value,
      title: category.startsWith("All: ") ? value.slice(value.indexOf("/") + 1) : value,
      description: b.model,
      footer: rate && rate[0] > 0 ? `$${rate[0]}/$${rate[1]}` : leadFooter(b.model, b.free),
      category,
    });
  };
  for (const id of state.favorite ?? []) add(id, "Favourites");
  for (const id of (state.recent ?? []).slice(0, recentMax)) add(id, "Recent");
  for (const k of Object.keys(bases)) add(bases[k].model, "Lead models");
  for (const m of state.all ?? []) {
    const before = out.length;
    add(m.id, `All: ${m.id.split("/")[0]}`);
    if (out.length > before && m.cost && m.cost[0] > 0 && !LEAD_RATES[out.at(-1).value]) {
      out.at(-1).footer = `$${m.cost[0]}/$${m.cost[1]}`;
    }
  }
  return out;
}

// -------------------------------------------------------------- choices --

// What each /fusion knob accepts. `set` validates against this table, and
// the TUI picker renders it: title is the value, description is the plain-
// language meaning, footer the cost or the caveat.
export const KNOBS = {
  base: {
    label: "Lead model",
    help: "The model that plans and decides. Pick by budget and quality.",
    options: (bases, _sidekicks, state) => baseOptions(bases, state),
    write: "base",
  },
  sidekick: {
    label: "Sidekick model",
    help: "The model that does the bulk reading, searching and mechanical edits.",
    options: (bases, sidekicks) =>
      Object.keys(sidekicks).map((value) => ({
        value,
        title: value,
        description: sidekickBlurb(value),
      })),
    write: "sidekick",
  },
  critic: {
    label: "Critic model",
    help: "Reviews diffs before work is called done.",
    options: () =>
      ["local", "strata", "flash", "lead"].map((value) => ({
        value,
        title: value,
        description: criticBlurb(value),
      })),
    write: "critic",
  },
  reasoning: {
    label: "Lead effort",
    help: "How hard the lead thinks. Clamped to levels the model offers.",
    options: () =>
      ["none", "low", "medium", "high", "xhigh", "max"].map((value) => ({
        value,
        title: value,
        description: effortBlurb(value),
      })),
    write: "reasoning",
  },
  speed: {
    label: "Speed",
    help: "fast spends a notch less reasoning and caps steps tighter.",
    options: () => [
      { value: "normal", title: "normal", description: "Full effort levels and step budget." },
      { value: "fast", title: "fast", description: "One notch less reasoning, tighter step budget." },
    ],
    write: "speed",
  },
  escalation: {
    label: "Escalation",
    help: "What happens when the lead cannot crack a problem.",
    options: () => [
      { value: "advise", title: "advise", description: "Write a handoff brief for Claude Code; nothing runs by itself." },
      { value: "run", title: "run", description: "Run claude -p directly after asking. Subscription, not balance." },
      { value: "fable", title: "fable", description: "Enable the paid oracle subagent on gateway balance." },
    ],
    write: "escalation",
  },
};

function sidekickBlurb(v) {
  return {
    local: "Resident llama.cpp model, medium effort. Free.",
    "local-fast": "Resident llama.cpp model, low effort. Free.",
    "local-deep": "Resident llama.cpp model, high effort. Free.",
    glm: "glm-5.3-flash through the gateway. Pennies.",
    deepseek: "deepseek-v4-flash through the gateway. Pennies.",
    strata: "Strata general model on :8082. Free.",
    "strata-coder": "Strata Coder model on :8082. Free.",
  }[v] ?? v;
}

function criticBlurb(v) {
  return {
    local: "Follows the sidekick model. Free when local.",
    strata: "The Strata model, high effort. Free.",
    flash: "glm-5.3-flash, low effort. Fractions of a cent per review.",
    lead: "The lead model itself at low effort. Strongest, small cost.",
  }[v] ?? v;
}

function effortBlurb(v) {
  return {
    none: "No reasoning passes.",
    low: "Light reasoning. Fastest.",
    medium: "Moderate reasoning.",
    high: "Deep reasoning. Default.",
    xhigh: "Very deep reasoning. Slower, pricier.",
    max: "The deepest level the model offers.",
  }[v] ?? v;
}

// The local seats whose per-agent reasoning_effort /fusion effort edits.
export const EFFORT_SEATS = ["scout", "grunt", "critic"];
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh"];

// --------------------------------------------------------- panel write ---

// Replace one top-level "key": <json> in a JSONC file, preserving comments
// and layout. Returns false when the key is not present (nothing written).
export function writePanelKey(file, key, value) {
  const text = fs.readFileSync(file, "utf8");
  const encoded = JSON.stringify(value);
  const re = new RegExp(`("${escapeRe(key)}"\\s*:\\s*)(?:[^,{\\[\\}"']+|"(?:[^"\\\\]|\\\\.)*"|\\[[^\\]]*\\]|\\{[^}]*\\})`, "");
  const replaced = text.replace(re, (m, pre) => `${pre}${encoded}`);
  if (replaced === text) return false;
  fs.writeFileSync(file, replaced);
  return true;
}

// Replace one seat level inside the "local_efforts" object.
export function writePanelEffort(file, seat, level) {
  const text = fs.readFileSync(file, "utf8");
  const objMatch = /("local_efforts"\s*:\s*\{)([^}]*)(\})/.exec(text);
  if (!objMatch) return false;
  const body = objMatch[2];
  const seatRe = new RegExp(`("${escapeRe(seat)}"\\s*:\\s*)"[^"]*"`);
  const newBody = seatRe.test(body)
    ? body.replace(seatRe, `$1"${level}"`)
    : `${body.trimEnd().replace(/,$/, "")}, "${seat}": "${level}" `;
  const replaced = text.slice(0, objMatch.index) + objMatch[1] + newBody + objMatch[3] + text.slice(objMatch.index + objMatch[0].length);
  if (replaced === text) return false;
  fs.writeFileSync(file, replaced);
  return true;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ------------------------------------------------------------- notices ---

// One notice: what happened plus one thing the user can do. `id` dedupes
// per server lifetime; the TUI dedupes again per client.
export function makeNotice(kind, message, action, extra = {}) {
  return {
    id: `${kind}:${hashish(message)}`,
    kind,
    severity: extra.severity ?? "warning",
    title: extra.title ?? "fusion",
    message,
    action,
    ...(extra.sessionID ? { sessionID: extra.sessionID } : {}),
  };
}

function hashish(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// A notice store: dedup by id, remember what was emitted, hold a pending
// queue for clients that are not subscribed yet.
export function makeNoticeStore(limit = 200) {
  const seen = new Set();
  const pending = [];
  return {
    offer(notice) {
      if (seen.has(notice.id)) return false;
      seen.add(notice.id);
      pending.push(notice);
      if (pending.length > limit) pending.shift();
      return true;
    },
    drain() {
      return pending.splice(0, pending.length);
    },
    // Peek without consuming: several TUI clients may connect over one
    // server lifetime, and each dedupes on its own side.
    list() {
      return [...pending];
    },
    size() {
      return pending.length;
    },
  };
}

// File-based notices: bin/oc-server drops one JSON line per launch-time
// finding the TUI user would otherwise never see (the warnings go to a
// stderr the TUI does not show). The plugin drains the file on every
// notices/status call and truncates what it consumed.
export function readPendingFile(file) {
  try {
    const text = fs.readFileSync(file, "utf8");
    const items = [];
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const n = JSON.parse(t);
        if (n && typeof n === "object" && typeof n.message === "string") {
          items.push({ id: n.id ?? `${n.kind ?? "external"}:${hashish(n.message)}`, ...n });
        }
      } catch {
        /* a partial line from a concurrent write is skipped, not fatal */
      }
    }
    return items;
  } catch {
    return [];
  }
}

export function clearPendingFile(file) {
  try {
    fs.writeFileSync(file, "");
  } catch {
    /* best effort */
  }
}

// ------------------------------------------------------- dropped keys ----

// Keys the opencode 2.0.20 normalizer drops with a diagnostic, grouped by
// where they sit in the config (source: packages/core/src/config/
// normalize.ts:46-55,328-329,568-576). Each audited entry names why the key
// stays: "v1-only" keys still serve the Mac host, "covered" ones have their
// effect supplied by the plugin or a native v2 mechanism.
export const DROPPED_TOP_LEVEL = ["logLevel", "server", "subagent_depth", "layout"];
export const DROPPED_EXPERIMENTAL = ["disable_paste_summary", "batch_tool", "openTelemetry", "primary_tools", "continue_loop_on_deny"];
export const DROPPED_COMPACTION = ["tail_turns", "prune"];
export const DROPPED_MODEL = ["release_date", "attachment", "reasoning", "temperature", "experimental"];

// Audited: key path -> why it is allowed to stay. Anything dropped that is
// NOT on this list produces a user-facing notice.
export const AUDITED_DROPS = {
  "experimental.batch_tool": "v1-only: v2 batches through the codemode execute tool by default",
  "experimental.primary_tools": "v1-only: v2 scopes tools through per-agent permissions",
  "compaction.prune": "v1-only: the plugin prunes stale tool outputs on v2",
  "compaction.tail_turns": "v1-only: v2 keeps recent tokens (preserve_recent_tokens -> keep.tokens), not turns",
};

const AUDITED_MODEL_FIELDS = new Set(["reasoning", "temperature", "tool_call", "options", "status", "interleaved", "release_date", "attachment", "experimental"]);

// Providers whose models the plugin rewrites on the wire (the http.request
// guard in index.js, which returns early for anything else). Only for these
// is a model option key the plugin does not re-inject dead: see the
// `options` branch below.
export const LOCAL_PROVIDER_IDS = ["llamacpp", "strata"];

// Scan one parsed config object and report every key v2 would drop, split
// into audited (documented, intentional) and unaudited (silently dead).
// opts.localProviders overrides which providers the plugin owns on the wire.
export function findDroppedKeys(cfg, opts = {}) {
  const localProviders = new Set(opts.localProviders ?? LOCAL_PROVIDER_IDS);
  const audited = [];
  const unaudited = [];
  if (!cfg || typeof cfg !== "object") return { audited, unaudited };
  for (const k of DROPPED_TOP_LEVEL) {
    if (Object.hasOwn(cfg, k)) unaudited.push(k);
  }
  const exp = cfg.experimental;
  if (exp && typeof exp === "object") {
    for (const k of DROPPED_EXPERIMENTAL) {
      if (!Object.hasOwn(exp, k)) continue;
      const path = `experimental.${k}`;
      (AUDITED_DROPS[path] ? audited : unaudited).push(path);
    }
  }
  const comp = cfg.compaction;
  if (comp && typeof comp === "object") {
    for (const k of DROPPED_COMPACTION) {
      if (!Object.hasOwn(comp, k)) continue;
      const path = `compaction.${k}`;
      (AUDITED_DROPS[path] ? audited : unaudited).push(path);
    }
  }
  const providers = cfg.provider;
  if (providers && typeof providers === "object") {
    for (const [pname, prov] of Object.entries(providers)) {
      if (!prov || typeof prov !== "object") continue;
      for (const k of ["id", "whitelist", "blacklist"]) {
        if (Object.hasOwn(prov, k)) unaudited.push(`provider.${pname}.${k}`);
      }
      const models = prov.models;
      if (!models || typeof models !== "object") continue;
      for (const [mname, model] of Object.entries(models)) {
        if (!model || typeof model !== "object") continue;
        for (const k of Object.keys(model)) {
          if (!DROPPED_MODEL.includes(k) && !["tool_call", "options", "status", "interleaved"].includes(k)) continue;
          const path = `provider.${pname}.models.${mname}.${k}`;
          // A model's `options` migrate to `settings` on v2, and settings
          // become the model's providerOptions on every request (config ->
          // model defaults, `providerOptions: n.settings`). The provider
          // adapter decides which of them it honors, so a key the plugin does
          // not re-inject is NOT automatically dead: an Anthropic provider,
          // for one, reads `thinking`. Only on the local providers does the
          // plugin own the wire, and only there is everything else dropped
          // (the adapter ignores unknown provider options, which is why the
          // plugin injects chat_template_kwargs and reasoning_effort itself).
          if (k === "options") {
            if (!localProviders.has(pname)) continue;
            const keys = Object.keys(model.options ?? {});
            const extras = keys.filter((x) => x !== "chat_template_kwargs" && x !== "reasoning_effort");
            if (extras.length) unaudited.push(`${path} (keys: ${extras.join(", ")})`);
            continue;
          }
          if (k === "status" && model.status === "deprecated") continue;
          if (k === "interleaved" && typeof model.interleaved !== "boolean") continue;
          if (AUDITED_MODEL_FIELDS.has(k)) audited.push(path);
        }
      }
    }
  }
  return { audited, unaudited };
}

// -------------------------------------------------------------- prune ----

// v1 `compaction.prune` parity for v2: shrink old tool outputs in the
// assembled context. Keeps protectTail characters of tool output near the
// tail untouched; older outputs larger than maxChunk shrink to maxChunk.
// Mutates the message parts the host hands to the context hook and returns
// how many results it pruned. Error results stay: losing an error message
// hides why the turn failed.
function toolResultTextOf(result) {
  if (!result || typeof result !== "object") return "";
  const v = result.value;
  if (result.type === "content" && Array.isArray(v)) {
    return v.map((p) => (p?.type === "text" ? p.text : String(JSON.stringify(p ?? "")))).join("\n");
  }
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return String(v ?? "");
  }
}

export function pruneOldToolOutputs(messages, { protectTail = 40000, maxChunk = 3000 } = {}) {
  let tail = 0;
  let pruned = 0;
  for (let i = messages.length - 1; i >= 0 && Array.isArray(messages); i--) {
    const content = messages[i]?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type !== "tool-result") continue;
      if (part.result?.type === "error") continue;
      const text = toolResultTextOf(part.result);
      if (tail + text.length <= protectTail || text.length <= maxChunk) {
        tail += text.length;
        continue;
      }
      part.result = {
        type: "text",
        value: `${text.slice(0, maxChunk)}\n[pruned ${text.length - maxChunk} characters]`,
      };
      tail += maxChunk;
      pruned += 1;
    }
  }
  return pruned;
}

// ----------------------------------------------------------- accounting --

// The same math as `oc-fusion usage`: total cost from the log, plus a
// shadow number: what the delegated tokens would have cost at lead rates.
export const LEAD_RATES = {
  "union-alpha": [0, 0],
  glm: [0.7, 2.2],
  "glm-flash": [0.015, 0.05],
  kimi: [2, 10],
  sonnet: [2, 10],
  opus: [4, 20],
  fable: [10, 50],
  sol: [2, 10],
  astra: [10, 50],
};

export function usageTotals(rows, base = "glm") {
  const byAgent = {};
  for (const r of rows) {
    const a = (byAgent[r.agent ?? "unknown"] ??= { msgs: 0, input: 0, output: 0, reasoning: 0, cost: 0 });
    a.msgs += 1;
    a.input += r.in ?? 0;
    a.output += r.out ?? 0;
    a.reasoning += r.reasoning ?? 0;
    a.cost += r.cost ?? 0;
  }
  const [rin, rout] = LEAD_RATES[base] ?? LEAD_RATES.glm;
  let shadowIn = 0;
  let shadowOut = 0;
  let totalCost = 0;
  for (const [agent, v] of Object.entries(byAgent)) {
    totalCost += v.cost;
    if (agent !== "fusion") {
      shadowIn += v.input;
      shadowOut += v.output + v.reasoning;
    }
  }
  return {
    byAgent,
    totalCost,
    shadowCost: (shadowIn * rin + shadowOut * rout) / 1e6,
    shadowIn,
    shadowOut,
    freeLead: rin === 0 && rout === 0,
  };
}

export function readUsageRows(file, sessionID) {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .flatMap((line) => {
        const t = line.trim();
        if (!t) return [];
        try {
          const r = JSON.parse(t);
          return sessionID && r.session !== sessionID ? [] : [r];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

// The long_context hint (see the profile default in index.js). Returns
// { message, action } when the step's prompt reached cfg.at on a model whose
// id contains cfg.model, else null. tokens is a v2 step's tokens object: the
// prompt is the new input plus the cached part.
export function longContextHint(cfg, model, tokens) {
  if (!cfg || !cfg.model || !cfg.switch_to || !Number(cfg.at) || !model?.id) return null;
  if (!String(model.id).includes(String(cfg.model))) return null;
  const prompt = (tokens?.input ?? 0) + (tokens?.cache?.read ?? 0);
  if (prompt < Number(cfg.at)) return null;
  return {
    // No token count in the text: the notice id hashes the message, so a
    // count would repeat the notice on every step.
    message: `This session is near the compaction point of ${model.id}.`,
    action: `Text only? Move it to ${cfg.switch_to} (/model): one swap instead of repeated compactions. That model may not read images.`,
  };
}
