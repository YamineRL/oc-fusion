import type { Plugin } from "@opencode-ai/plugin"

// RTK OpenCode plugin, vendored from rtk's own `rtk init -g --opencode`
// output (rtk 0.49.0) so the harness carries it in-tree instead of writing
// into the user's global config on install.
//
// It rewrites Bash tool commands to their `rtk` equivalents before they
// run, so every agent — lead, sidekick, subagent — reads compressed
// output. All rewrite logic lives in `rtk rewrite` (the Rust registry in
// rtk's src/discover/registry.rs); this file only delegates. To add or
// change rewrite rules, update rtk — not this file.
//
// Graceful degradation: no rtk in PATH → the plugin disables itself and
// commands run unchanged. A failed rewrite passes the command through.

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
