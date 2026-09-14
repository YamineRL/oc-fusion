# Using the harness

Daily-driver guide. For architecture and rationale, read README.md.

## Start

```
oc                    # in any project (one-time PATH setup, see README)
oc run "..."          # one-shot
```

Nothing to boot: llama-server is a systemd user service. After a reboot,
`oc-fusion doctor` confirms the server is up and the right model is resident.

## Day to day

Talk to the lead. It plans, makes the subtle edits itself, and delegates the
volume — reading, searching, mechanical changes, test loops — to the free
local model. You get the best results by working *with* that split:

- Give the task and its acceptance check, not a step-by-step procedure.
  The lead decides what to delegate; a procedure tempts it to do everything
  itself.
- Long output is handled for you: huge results go to a file and the lead
  sends scout at it; merely-large ones get summarized with head/tail intact.
- Before you accept non-trivial work, ask for a critic pass. (`critic` is
  the weakest-model review by default; see below.)

## The knobs you'll actually touch

```
oc-fusion status                    # what's live
oc-fusion base glm|fable|...        # lead; glm-5.3-class is the floor, fable/astra/opus are on-par
oc-fusion critic local|flash|lead   # who reviews diffs — see README
oc-fusion speed fast                # faster session: -1 reasoning notch on the lead
oc-fusion escalation advise|run|fable
```

- **`critic lead`** is worth setting when the work is subtle: the lead
  re-reads its own diff at low effort, sub-cent per review.
- **`escalation advise`** (default) is usually right. When the lead gets
  stuck it writes `.fusion/escalation-<time>.md` and prints the exact
  `claude` command — run it if you want Claude Code's answer (billed to
  your subscription, not the gateway). `run` does that automatically,
  `fable` spends gateway balance.
- A `fusion.jsonc` in the project you're working in overrides the panel —
  that's per-repo pinning, but it also means a stray file silently wins.

## Watching the money

```
oc-fusion usage
```

Per-agent tokens and cost from `.fusion/usage.jsonl`, plus the shadow line:
what the delegated tokens *would* have cost at lead rates — the ceiling of
what delegation saved, not a claim. If the lead's share of total tokens is
climbing over sessions, it's under-delegating; say so to it.

## Things that bite

- **Concurrent local calls queue.** One llama-server slot: a fan-out of six
  scouts serializes. Two or three parallel tasks are fine.
- **15 idle minutes sleeps the model.** The next scout call pays a reload
  (seconds, from page cache). First call after a break feels slow; that's
  why.
- **Never name another local model.** `--models-max 1` means any non-resident
  local model id evicts the resident model mid-generation. The guard warns by default;
  don't turn it off.
- **Subagent results return to the lead, not to you.** If you want the raw
  findings of a scout trip, ask the lead to include them.

## Experiments

`FUSION_PROFILE=/path/to/panel.jsonc oc ...` runs a session against a
throwaway panel (different base, critic, escalation) without touching the
harness's `fusion.jsonc`.
