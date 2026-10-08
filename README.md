# oc-fusion

A two-tier coding harness for [opencode](https://opencode.ai), built around
local inference you already own.

A strong lead model does the thinking — frontier-class in the on-par
configuration, GLM-5.3-class as the sensible floor. A model on your own GPU —
or a cheap flash-class API model — does the reading, searching, mechanical
editing, and test-running. What the lead cannot crack goes to a Claude Code
subscription you already pay for, instead of a per-token frontier fallback.
And under both tiers, a local [Graft](https://github.com/trailhq/Graft) graph
maps every project — symbols, call edges, exact file:line — while
[rtk](https://github.com/rtk-ai/rtk) compresses command output before any
agent reads it. No agent re-explores the repo from zero, and no agent reads
two hundred lines to learn a test failed.

The savings live in the sidekick, never in the lead. That is the whole
design: strongest affordable brain, cheapest possible hands.

Every knob is honest about what it does, and every claim in this README was
measured on the reference setup (a 27B-class quantized model on a 16 GB card
at 45k context), not extrapolated. Strata speed numbers are Strata's own
measurements and are marked as such.

## The idea

Most tokens in a coding session are spent *reading* things, not reasoning
about them. This is the pattern commercial agent products converged on in
2026 — notably Devin's Fusion, which pairs a frontier lead with a cheap
sidekick and bills per token for both. Artificial Analysis measured the
effect there: Fable 5.1 alone cost $12.40/task, while Fable 5.1 + SWE-2 hit
the same index score at $7.90.

oc-fusion is that shape with a different cost structure:

|          | Devin Fusion       | oc-fusion, on-par               | oc-fusion, frugal | Cost (in/out per M) |
|----------|--------------------|---------------------------------|-------------------|---------------------|
| Lead     | Claude Fable 5.1   | same class (Fable / Opus / Astra) | GLM-5.3 (the floor) | $0.70/$2.20 … $10/$50 |
| Sidekick | SWE-2 (medium)     | Strata (125B MoE) or your own GGUF, or a flash-class API model | same | **$0** or ~$0.03/$0.07 |
| Repo map | (closed)           | Graft, local per-repo graph      | same              | **$0**              |
| Output   | (closed)           | rtk, compresses command output   | same              | **$0**              |
| Escalation | (none)           | Claude Code (subscription)      | same              | $0 gateway          |

Two configurations, one harness:

- **On-par with Fusion**: `oc-fusion base fable` (or astra/opus). Same lead
  class Fusion uses, the subscription-instead-of-frontier escalation, and a
  sidekick that bills $0 because it is your own hardware. This is the config
  to reach for when the task is hard and you want Fusion's shape at a
  fraction of Fusion's bill.
- **Frugal** (default): `oc-fusion base glm`. GLM-5.3 is the floor — below
  it you lose the "strong lead" property the architecture depends on, and
  the savings should come from the sidekick instead. Cheap flash-class
  models are for the sidekick tier, not the lead.
- **Free lead**: `oc-fusion base union-alpha`. OpenCode Zen's stealth model
  built for agentic coding, released 2026-09-16, $0 in / $0 out. It
  advertises no reasoning levels — the model manages its own effort, so the
  `reasoning` knob is ignored for it (the harness sends no variant). A
  stealth model has no public benchmarks: treat it as an experiment while
  Zen keeps it free, not as a floor replacement. Use it when the lead
  should cost nothing; flip back to `glm` or `fable` when it isn't
  cutting it.

The sidekick is where the money is. If you run a local inference server at
all, the marginal cost of a sidekick token is zero — and the harness
discovers whatever model your server has resident, so it never asks for a
model that isn't loaded.

### What Strata adds

Until now, a free local sidekick meant a model that fits in VRAM: on a
16 GB card, a 27B-class quantized model (the reference setup above).
[Strata](https://github.com/Niko1221/Strata) removes that limit. It runs
Qwen3.8-Flash-Next, a 125-billion-parameter mixture-of-experts model, on one
NVIDIA or AMD card with 12 GB of VRAM or more plus system RAM. The experts
stay in RAM and the dense weights go to the card. The sidekick tier moves
from a 27B-class model to one that usually needs a server, still at $0 per
token, and nothing leaves your PC.

Strata's own measurements, on an RTX 5070 (12 GB) with 64 GB of RAM:
IQ3_XXS, the oc-fusion default, writes 62 tokens/s and reads a 32K-token
prompt at 1,750 tokens/s. IQ3_S, which matches the full model on the
published tests, writes 53 tokens/s. Your RAM and VRAM decide which size
fits (see [Strata](#strata) below). Strata is the default sidekick, and
llama.cpp stays fully supported.

## The five roles

| Agent    | Tier    | Does |
|----------|---------|------|
| `fusion` | lead    | plans, decides, makes the subtle edits, talks to you |
| `scout`  | sidekick | finds things, traces call sites, reads long files, returns ~400 words |
| `grunt`  | sidekick | executes decided changes, runs tests, iterates to green |
| `critic` | sidekick* | reviews the diff before work is called done |
| `oracle` | frontier| **off by default.** Only exists when `escalation` is `fable` |

`scout` is where the savings are. The lead never burns its own context reading
a 3000-line file to find one function — and with a `graft/` index in the
project, it often skips the file read entirely: the graph answers with exact
file:line and the crux lines inline, so a find/trace becomes one tool call
instead of a browse.

The `critic` knob picks the reviewer (`local | strata | flash | lead`),
independent of the sidekick. The default is `strata`: the Strata model on
:8082 at high effort, free. A local critic can be the weakest model in your
fleet auditing the strongest editor, which is backwards for subtle edits.
`lead` re-reviews at low effort, typically well under a cent per review. On
a lead with no reasoning levels (union-alpha) `critic lead` self-reviews
with no variant: same model, its default effort.

## Install

### Option A: clone

```
git clone https://github.com/YamineRL/oc-fusion.git
cd oc-fusion && npm --prefix .opencode install
npm install -g @nanonets/graft
brew install rtk
```

Then follow "Running it".

### Option B: one-prompt install

Open opencode in any directory and paste this. The agent clones the repo,
installs the plugin dependency, sets up Strata (or wires in your llama-server)
as the local sidekick, and puts both commands on your PATH. It asks before
anything that touches files outside the repo.

````text
Install the oc-fusion harness from https://github.com/YamineRL/oc-fusion
into ~/oc-fusion (clone if the directory does not exist; pull if it does).
The default local sidekick is Strata (https://github.com/Niko1221/Strata).
llama.cpp also works. Then:

1. Run `npm --prefix ~/oc-fusion/.opencode install` and confirm it succeeds.
2. Install the repo-graph layer: `npm install -g @nanonets/graft` (Node 20+).
   It is part of the harness, not an extra.
3. Install the output layer: `brew install rtk` (or
   `cargo install --git https://github.com/rtk-ai/rtk`, or a prebuilt binary
   from its releases). Also part of the harness, not an extra.
4. Check my PC and show me the result: GPU and VRAM (`nvidia-smi`, or
   `lspci` and /sys/class/drm/card*/device/mem_info_vram_total for AMD),
   RAM (`free -g`) and free disk.
5. Set up Strata as the sidekick:
   - If `curl -s http://127.0.0.1:8082/health` answers, Strata is already
     running. Go to the last bullet of this step.
   - Otherwise, clone https://github.com/Niko1221/Strata and run its own
     check (`./setup.sh --check`; it installs only Python and a .venv). It
     reports the GPU, VRAM, RAM and whether this PC can run Strata. Strata
     needs a supported GPU with 12 GB of VRAM or more (an 8 GB NVIDIA card
     runs, slowly).
   - Pick the size from my RAM and VRAM together, as Strata's README and
     docs/MODELS.md say. In normal mode a size fits when RAM is at least
     its experts plus about 10 GB (experts: Q2_0 34 GB, IQ2_XS 35.5 GB,
     IQ3_XXS 43 GB, IQ3_S 50 GB, Coder 23 GB). Take IQ3_XXS or better when
     it fits:
     - 96 GB RAM or more: `--family qwen --model IQ3_S`.
     - 64 GB: `--family qwen --model IQ3_XXS` (the oc-fusion default;
       IQ3_S fits with little else open; IQ2_XS is faster).
     - 48 GB: `--family qwen --model IQ2_XS` (Q2_0 is the fastest).
     - 32 GB: the experts do not fit in RAM, so setup uses its low-RAM
       mode and VRAM decides. With a 24 GB card: `--family qwen --model
       IQ2_XS` (or Q2_0) for general use, or the Coder. With a 12-16 GB
       card: only `--family coder` (Coder IQ1_M), and it is much slower.
     More VRAM makes every size faster and raises setup's default context
     (32768 under 14 GB of VRAM, 65536 under 20 GB, else 131072). If I
     mainly write code, offer the Coder. Show me your pick and the reason.
   - Ask me before you install: the model download is 70-110 GB. Then
     follow Strata's docs/AI_SETUP.md, with `--no-start`.
   - Serve on port 8082 with a key, so Strata does not clash with
     llama-server on 8080. If ~/.config/strata/api-key does not exist,
     write a random hex string to it (chmod 600). Pass `--port 8082
     --api-key=<that key>` to Strata's setup. Start the server as its
     docs/AI_SETUP.md says, and poll /health until "loaded" is true.
   - Read "model" and "max_context" from /health. In
     ~/oc-fusion/opencode.jsonc, provider "strata": for the Coder, set
     models.strata-coder "id" and "limit.context" from them; for any other
     model, set models.strata-iq3 instead. Keep the alias names.
   - In ~/oc-fusion/fusion.jsonc, set "sidekick" to "strata", or to
     "strata-coder" for the Coder. Leave "critic" at "strata".
6. Optional, only if I already run llama-server: find
   ~/.config/systemd/user/llama-server.service. From its ExecStart, note the
   port and the context size -c. Get the model's wire id from the RUNNING
   server (`ps -eo args= | grep llama-server`, the --alias value or the
   .gguf basename). Do not start or restart it. Set provider "llamacpp"
   baseURL to http://127.0.0.1:<port>/v1, point apiKey at its
   --api-key-file (or remove apiKey if it needs no key), and set the three
   fusion-sidekick alias "id" fields to that wire id. Strata and
   llama-server share the GPU: run one at a time.
7. Add ~/oc-fusion/bin to my PATH permanently. My shell is
   <fish|bash|zsh>: use fish_add_path for fish, or append the export to the
   right rc file for bash/zsh.
8. Verify: run `oc-fusion doctor` and show me the output. It should report
   the Strata model, its context, the key file, and graft + rtk lines
   without warnings.
9. Do not start a session yet. Report what you did, what you guessed, and
   what I should change (especially the lead model in fusion.jsonc "base"
   if I do not want the default).

Work from the repo's README.md if a step is unclear. Ask me before doing
anything destructive or anything not listed here.
````

Replace `<fish|bash|zsh>` with your shell before pasting. The prompt is
self-contained: it assumes nothing about your model or gateway, discovers
them from your system, and defers to you on everything it cannot read.

## Running it

`bin/oc` is the entry point. It exports `OPENCODE_CONFIG` and execs opencode,
so the harness travels into whatever repo you are in:

```
oc                  # interactive, in the current project
oc run "..."        # one-shot
```

Put it on your PATH once and the harness is available everywhere:

```fish
fish_add_path /path/to/oc-fusion/bin   # fish, once; then `oc` and `oc-fusion` work everywhere
```

```bash
echo 'export PATH="/path/to/oc-fusion/bin:$PATH"' >> ~/.bashrc   # bash, once; then restart your shell
```

The control panel is resolved in this order: `$FUSION_PROFILE`, then a
`fusion.jsonc` in the project you are working in (so a repo can pin its own
lead and sidekick), then the harness's own. Running plain `opencode` inside
the harness directory also works, because opencode reads `./opencode.jsonc`.

## The control panel

Edit `fusion.jsonc`, or use the CLI:

```
oc-fusion status                 # current panel + what is actually resident
oc-fusion base <model>           # the lead; see the table in fusion.jsonc
oc-fusion sidekick local|local-fast|local-deep|glm|deepseek|strata|strata-coder
oc-fusion critic local|strata|flash|lead
oc-fusion reasoning low|medium|high|xhigh|max
oc-fusion speed normal|fast
oc-fusion escalation advise|run|fable
oc-fusion oracle <model>         # only when escalation=fable
oc-fusion guard strict|warn|off
oc-fusion compress on|off
oc-fusion routing observe|enforce
oc-fusion work submit|list|results
oc-fusion graft <cmd> [args...]  # the repo graph, offline-wrapped (see Graft)
oc-fusion usage                  # per-agent token + cost accounting
oc-fusion doctor                 # check the config against Strata and the llama-server unit
```

Changes apply on the next opencode start.

**Reasoning levels are clamped per model.** opencode derives variants from
each model's advertised `reasoning_options`, and vendors differ. A request is
clamped to the nearest level *at or below* it, so it never silently costs
more than asked.

**Speed is honest about what it can do.** Where your gateway publishes
vendor `-fast` twins, `speed: fast` uses them; otherwise fast means one notch
less reasoning and a tighter step budget, and the plugin says so on startup
rather than pretending otherwise.

## Strata

[Strata](https://github.com/Niko1221/Strata) is the default local sidekick.
It serves one model on `127.0.0.1:8082` and answers every model name with
it. The API key file is `~/.config/strata/api-key`. The plugin sends the
panel's `local_efforts` to Strata in `chat_template_kwargs`, the same field
llama.cpp reads. Strata and llama-server share the GPU, so run one at a
time. `oc-fusion doctor` reads `/health` and warns when the served model or
its context disagree with the panel.

The model size depends on RAM and VRAM together. RAM decides which sizes
fit, VRAM decides the speed, the default context, and what runs in Strata's
low-RAM mode on a 32 GB PC. Option B above applies the rules from Strata's
README and [docs/MODELS.md](https://github.com/Niko1221/Strata/blob/main/docs/MODELS.md).

## Your local server is the source of truth

This section applies to llama.cpp. For Strata, the plugin sends the
configured id unchanged, never probes residency, and skips the guard:
Strata answers any model name and never evicts.

The harness parses your llama-server systemd unit at startup rather than
duplicating its flags, and adapts to it:

- **The sidekick model is discovered, not configured.** The wire id is read
  passively from the running server's `--alias` (or `.gguf` basename). The
  harness therefore cannot ask for a model that isn't resident. Pin
  `local_model` in fusion.jsonc if you want it fixed across restarts.
- **Context.** Declared local context is clamped to `ctx - 1024` (per slot
  under `--parallel N`), so opencode never packs a prompt the server has to
  reject.
- **Sampling.** Yours, from the unit. The plugin strips opencode's own
  temperature/top_p/top_k from local requests instead of fighting them.
- **Reasoning effort.** llama.cpp reads it from `chat_template_kwargs`; the
  plugin injects it per agent from the panel's `local_efforts`. A chat
  template throws on an effort level it doesn't know, so adjust to your
  model.

An example unit ships in `examples/llama-server.service`. Sidekick model
requirements: tool calling, reasoning, and a chat template that accepts
`reasoning_effort` through `chat_template_kwargs` under `--jinja`.

## The eviction guard

This section applies to llama.cpp. For Strata, the plugin sends the
configured id unchanged, never probes residency, and skips the guard:
Strata answers any model name and never evicts.

llama-server runs `--models-max 1` in the example unit: naming a model that
is not resident **unloads the resident one mid-generation**. A multi-agent
harness is exactly the wrong shape for that, so there are two defenses:

1. **Structural.** All local aliases send the same discovered wire id, so
   switching sidekick profiles cannot trigger a load.
2. **A guard.** `chat.params` compares the outgoing local model against what
   is actually resident. It never probes an inference endpoint, so the check
   itself cannot cause a load. `guard: "strict"` refuses the request;
   `"warn"` logs loudly and allows.

`--parallel 1` also means concurrent local calls **queue** rather than
overlap. Two parallel scouts are fine; eight are a stall. This is in the
lead's prompt. Need real burst parallelism? Point `sidekick` at a cheap
flash-class API model instead — that is exactly what that knob is for.

## Evidence routing

The tier a piece of work runs on is decided by measurement, not by the lead's
judgment. The plugin keeps counters in its own memory and mirrors them to
`.fusion/control.jsonl`, so compaction cannot prune the retry history away,
and on every compaction the current stall and scope state is injected back
into the lead's context. `routing: "observe"` (default) logs and annotates
without blocking; `routing: "enforce"` throws on the call so it never runs.
Either way every decision lands in the control log.

- **Command stalls.** The normalized command string (recorded before rtk
  rewrites it) plus its exit code is the key. The same command failing
  `stall_commands` times in a row blocks identical retries for every agent,
  lead included - a different argument string is a different command.
- **File stalls.** A file edited `stall_edits` times by one sidekick agent
  without a green verification run moves to the lead. A passing
  verification command (test/typecheck/lint/build-shaped) resets the clock.
- **Scope.** With a `graft/` index in the project, a sidekick's first edit of
  a file measures its dependents (`skeleton` + `callers`), and every third
  sidekick edit re-measures the working diff (`graft blast`, offline-wrapped
  like every graft call). Files or diffs with more than `grunt_max_blast`
  dependents are lead territory. No index means scope is *unknown*, and
  unknown never blocks - it is logged as unknown.
- **Protected paths.** `protected_paths` prefixes are sidekick-forbidden
  regardless of measurements (migrations, deploy manifests). The lead can
  still edit them with owner approval; only escalation sits above the lead.

## Work orders (seats <-> harness)

A seat layer (a Chief of Staff / Engineering Lead setup, or anything that can
write a file) hands work to the harness through `.fusion/inbox/` and reads
outcomes from `.fusion/outbox/` - no pasting briefs between chats.

```
oc-fusion work submit order.md   # validate + file into .fusion/inbox/
oc-fusion work list              # pending/claimed/done, from work-orders.json
oc-fusion work results           # the outbox envelopes
```

`examples/work-order.md` is a fill-in skeleton for the brief format, and
`examples/seats.md` is a full generic seat layer (Chief of Staff plus seven
reporting seats, all `<…>` placeholders) for anyone who wants the layer that
writes these orders. `.fusion/` itself is created by the harness at runtime
and is gitignored, so nothing to set up by hand.

The contract is small: frontmatter with `id` and `seat`, an `## Objective`
section, and an `## Acceptance` section naming the checks that make it done.
Inside a session the lead uses the `work_order` tool - `list`, `accept`,
`report` - and `report` writes an envelope carrying the files touched, the
checks run with their exit codes, and the routing evidence (stalls, scope).
An `escalate` call also writes a `needs-decision` envelope to the outbox, so
escalations flow back up on their own. Claim state lives in
`.fusion/work-orders.json`; a second session accepting a claimed order is
refused.

The split stays where it was: seats decide, the harness executes, and money,
publishing, deploys and external contact wait for the owner no matter what a
brief asks for.

## Graft (the repo graph)

[Graft](https://github.com/trailhq/Graft) is the third tier: a repo context
graph as a folder of linked markdown — a local, regenerable cache that every
query keeps in sync with the code. It is part of the setup, not an add-on:
the graph lives in **your project**, never in the harness, and its core
needs no LLM and no key. Agents use the graft tools first and fall back to
grep only where a project has no `graft/` index yet.

- **Install once, globally**: `npm install -g @nanonets/graft` (Node 20+).
  On a new machine, `oc-fusion doctor` nags you until it's there.
- **Build in the project you work in**: `graft build`. The structural pass —
  wiring graph plus per-file cards — is $0 and keyless. `--deep` adds the
  LLM concept map and per-symbol summaries; it needs a provider key, and
  nothing in this harness runs it automatically.
- **Query locally**: `graft ask "..."`, `graft grep <pattern>`, `graft map`,
  `graft callers <symbol>`, `graft skeleton <file>`, `graft check`. All
  structural, all $0.
- **MCP**: `opencode.jsonc` registers `graft mcp` as a local stdio server,
  launched through the same offline wrapper as the CLI (below). OpenCode
  starts it with the session's project directory as its cwd, so it indexes
  whatever repo you have open — no path is hardcoded, and the harness
  directory is never the target. The agents then get `graft_repo_map`,
  `graft_find_code`, `graft_find_all`, `graft_trace_calls`, `graft_file_api`
  and `graft_check_freshness`. In a project with no `graft/` index the
  server starts and advertises no tools; the agents fall back to grep and
  scout.
- **CLI fallback**: the same queries run from the shell — `oc-fusion graft
  map`, `oc-fusion graft ask "..."` — forwarded to the `graft` CLI in your
  current project, not the harness root.
- **Privacy**: every graft process Fusion starts — MCP server or CLI
  forward — runs through a Linux `unshare` wrapper that removes network
  access for the process **and its children** (Graft's daily npm update
  check survives `DO_NOT_TRACK` otherwise), sets `DO_NOT_TRACK=1` for its
  anonymous usage stats, and refuses `--deep` so no provider-backed LLM
  pass can run through the harness. Missing isolation fails closed with an
  error, never online. This is network isolation, not a filesystem sandbox:
  queries may still refresh the project's local `graft/` cache.

Restart opencode after changing the `mcp` block in `opencode.jsonc`, like
every other config change in this harness.

## rtk (the output tier)

[rtk](https://github.com/rtk-ai/rtk) compresses command output before any
agent reads it — `git status` to a stat line, test runs to failures only,
listings to tree summaries — a single Rust binary, <10ms overhead. It is
part of the setup, and it covers **every** agent in the harness: lead,
sidekick, subagents, because it rewrites at the Bash tool layer, not per
agent.

- **Install**: `brew install rtk` (or
  `cargo install --git https://github.com/rtk-ai/rtk`, or a prebuilt
  release binary). `oc-fusion doctor` reports it and nags until present.
- **How it runs**: the vendored plugin
  `plugins/rtk/index.ts` (from rtk's own `rtk init -g --opencode`)
  rewrites each Bash command via `rtk rewrite` before execution. No rtk in
  PATH → the plugin disables itself and commands run unchanged; a failed
  rewrite passes through. Nothing is written into your global config.
- **What it saves**: the numbers rtk reports are reductions in **bash
  output**, not in your bill — bash output is one contributor among
  prompt, history, and output tokens. Percentages are reliable, absolute
  token counts are estimated (bytes/4).
- **Division of labour**: rtk compresses at the source, before output
  reaches a model. The harness's `compress_tool_output` knob still exists
  for large-but-intact output rtk passes through (it runs after rtk, and
  only in paid sessions). Truncated-to-file output still goes to scout
  with the path — that route is lossless and free. `rtk recall <id>`
  recovers the full output of a failed command rtk compacted.
- **Privacy**: this rtk build ships no telemetry endpoint (verify with
  `rtk telemetry status`); its usage stats are local, and `rtk gain`
  reads them from disk.

Restart opencode after changing the plugin list, like every other config
change in this harness.

## Accounting

Every completed assistant message is logged to `.fusion/usage.jsonl` in the
project directory: timestamp, session, agent, model, input/output/reasoning
tokens, cache read/write, and cost. `oc-fusion usage` aggregates it per agent
and prints a shadow line — what the delegated (non-lead) tokens would have
cost at lead rates. That shadow is the *ceiling* of what delegation saved,
not a claim: it over-counts because a lead would not re-read everything the
sidekick read, and local-agent `in` can under-count because llama.cpp bills
cached prompt tokens as `cache_read` rather than `in`. Not logged: `claude -p`
escalations (outside opencode) and chat-title generation (skipped as summary
messages).

## Escalation

When the lead is genuinely stuck, it calls the `escalate` tool. It has to
fill in a brief first: the problem, what it already ruled out and how it
knows, the relevant `path:line`s, and the one specific question it needs
answered. That brief is the whole value of the handoff, and requiring it
also stops the lead escalating instead of investigating.

Three routes, set with `oc-fusion escalation`:

- **`advise`** (default). Writes the brief to `.fusion/escalation-<time>.md`,
  hands you the exact `claude` command, and stops. Spends nothing anywhere.
- **`run`**. Invokes `claude -p` with the brief directly and returns the
  answer into the session. Asks permission the first time. Billed to your
  Claude Code subscription, not to your lead's gateway. It gets
  `Read,Glob,Grep,WebSearch,WebFetch` and nothing else: a non-interactive
  `claude -p` cannot be granted approvals mid-run, so treat this route as
  "answer my question about the code", not "go fix it".
- **`fable`**. Enables the paid `oracle` subagent instead (whichever model
  `oracle` names, at `max` effort). This is the only route that spends your
  lead's per-token budget, so it is opt-in.

The prompt tells the lead that escalating is not a failure and that the real
failure is twenty turns of retrying a variation that is not working: two
honest attempts, then escalate. On `advise` and `run` the `oracle` agent is
not registered at all, so a stuck lead has no path to frontier tokens even
if it goes looking for one.

## Oversized tool output

Two routes, and the distinction matters.

**Huge output** is handled by opencode before this plugin sees it: it
truncates to `tool_output.max_bytes` and writes the full text to a file. The
plugin does not summarize that, because the file is lossless and greppable.
It appends a directive telling the lead to delegate to scout with the path,
which is free and can search the part that was cut.

**Large but intact output**, between `compress_threshold` and `max_bytes`,
has no file to delegate to, so the local model summarizes the middle while
head (2000 chars) and tail (1000) stay verbatim. This is a context-window
optimization, not a cost one; set the threshold to suit your lead's prices.

## Tool-output compression

When a tool returns more than `compress_threshold` characters in a *paid*
agent's session, the sidekick model summarizes it first. It never fires for
local agents, which read for free, and a failure here is swallowed rather
than breaking the tool call.

`small_model` (chat titles) should NOT point at the local model: otherwise
merely opening a session wakes the GPU to name a chat.

## Layout

```
fusion.jsonc               the control panel
opencode.jsonc             providers, local aliases, agent definitions
prompts/*.md               the five role prompts
plugins/fusion/index.js    routing, the guard, effort injection, compression,
                           discovery, accounting
plugins/rtk/index.ts       vendored rtk output-compression plugin (Bash rewrite)
bin/oc                     entry point
bin/oc-fusion              panel CLI + doctor + usage + graft forwarder
examples/llama-server.service  example local-server unit
```

Per project: a `graft/` graph directory (git-ignored, regenerable via
`graft build`) and a `.fusion/` directory for usage logs and escalation
briefs.

## Credit

The two-tier lead/sidekick shape and the per-knob control panel are inspired
by Devin Fusion (Cognition). Artificial Analysis' public measurement of the
Fable/SWE-2 cost split is what motivated the cost structure here. This
project is an independent, unofficial harness for opencode and is not
affiliated with Cognition.

## License

GPL-3.0 — see LICENSE.
