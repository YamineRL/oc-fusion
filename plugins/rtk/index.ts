import { execFile, spawnSync } from "node:child_process"
import type { Plugin } from "@opencode-ai/plugin"

// RTK OpenCode plugin, vendored from rtk's own `rtk init -g --opencode`
// output (rtk 0.49.0) so the harness carries it in-tree instead of writing
// into the user's global config on install.
//
// It rewrites shell tool commands to their `rtk` equivalents before they
// run, so every agent — lead, sidekick, subagent — reads compressed
// output. All rewrite logic lives in `rtk rewrite` (the Rust registry in
// rtk's src/discover/registry.rs); this file only delegates. To add or
// change rewrite rules, update rtk — not this file.
//
// Graceful degradation: no rtk in PATH → the plugin disables itself and
// commands run unchanged. A failed rewrite passes the command through.
//
// Dual plugin shape: OpenCode v2 calls `default.setup(context)`; v1 hosts
// call `default.server` (detect mode) or the named export below (iterating
// loaders).

export const RtkOpenCodePlugin: Plugin = async ({ $ }) => {
  try {
    await $`which rtk`.quiet()
  } catch {
    console.warn("[rtk] rtk binary not found in PATH — plugin disabled")
    return {}
  }

  return {
    "tool.execute.before": async (input, output) => {
      const tool = String(input?.tool ?? "").toLowerCase()
      if (tool !== "bash" && tool !== "shell") return
      const args = output?.args
      if (!args || typeof args !== "object") return

      const command = (args as Record<string, unknown>).command
      if (typeof command !== "string" || !command) return

      try {
        const result = await $`rtk rewrite ${command}`.quiet().nothrow()
        const rewritten = String(result.stdout).trim()
        if (rewritten && rewritten !== command) {
          ;(args as Record<string, unknown>).command = rewritten
        }
      } catch {
        // rtk rewrite failed — pass through unchanged
      }
    },
  }
}

// OpenCode v2: the tool hook event is { tool, sessionID, agent, messageID,
// id, input }; `input` is the call's argument object, mutated in place.
const setupV2 = async (ctx: any) => {
  const which = spawnSync("which", ["rtk"], { encoding: "utf8" })
  if (which.status !== 0) {
    console.warn("[rtk] rtk binary not found in PATH - plugin disabled")
    return
  }

  const rewrite = (command: string): Promise<string | null> =>
    new Promise((resolve) => {
      execFile("rtk", ["rewrite", command], { timeout: 10_000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        // rtk exits non-zero (3) when it has a rewrite to offer; stdout is
        // the answer regardless of exit code, the same as the v1 .nothrow()
        // call. Spawn and timeout failures are the only real errors.
        if (err?.killed || err?.signal) return resolve(null)
        const out = String(stdout ?? "").trim()
        resolve(out || null)
      })
    })

  await ctx.tool.hook("execute.before", async (event: any) => {
    const tool = String(event?.tool ?? "").toLowerCase()
    if (tool !== "shell" && tool !== "bash") return
    const args = event.input
    if (!args || typeof args !== "object") return

    const command = (args as Record<string, unknown>).command
    if (typeof command !== "string" || !command) return

    const rewritten = await rewrite(command)
    if (rewritten && rewritten !== command) {
      ;(args as Record<string, unknown>).command = rewritten
    }
  })
}

export default {
  id: "rtk",
  server: RtkOpenCodePlugin,
  setup: setupV2,
}
