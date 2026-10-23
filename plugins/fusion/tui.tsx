// The TUI half of the fusion harness. One slash command, /fusion, that does
// everything the oc-fusion CLI does through pickers and readouts: it never
// sends a prompt, so the lead model is not in the loop. State and failures
// arrive over the "fusion" RPC the server plugin registers; notices also
// land as toasts, deduped once per TUI.
//
// External TUI plugins may only import @opencode/plugin/tui (the runtime
// remaps it) and plain relative files: no JSX, no solid-js, no opentui.
// Every surface here is therefore a built-in dialog or toast primitive.

import { Plugin } from "@opencode/plugin/tui";
import { FUSION_RPC } from "./panel.mjs";

const MENU = [
  { value: "status", title: "status", description: "Panel, backends, graft/rtk, session cost and what delegation saved" },
  { value: "base", title: "base", description: "Pick the lead model" },
  { value: "sidekick", title: "sidekick", description: "Pick the model that does the bulk work" },
  { value: "critic", title: "critic", description: "Pick the review model" },
  { value: "effort", title: "effort", description: "reasoning_effort per local seat (scout, grunt, critic)" },
  { value: "reasoning", title: "reasoning", description: "Lead model effort" },
  { value: "speed", title: "speed", description: "normal or fast" },
  { value: "escalation", title: "escalation", description: "advise, run (Claude Code) or fable (paid oracle)" },
  { value: "doctor", title: "doctor", description: "Run the full harness health check" },
  { value: "help", title: "help", description: "What each /fusion command does" },
];

const HELP = [
  "/fusion controls the oc-fusion harness without touching the model.",
  "",
  "  status       panel, backends, graft/rtk, session cost, delegation savings",
  "  base         lead model (the one that plans and decides)",
  "  sidekick     bulk-work model: local llama.cpp, Strata, or a cheap gateway model",
  "  critic       review model that checks diffs before work is called done",
  "  effort       reasoning effort per local seat: scout, grunt, critic",
  "  reasoning    lead model effort",
  "  speed        fast = one notch less reasoning and a tighter step budget",
  "  escalation   advise = write a Claude Code brief; run = run claude -p after asking; fable = paid oracle",
  "  doctor       run oc-fusion doctor and show the output",
  "",
  "Type /fusion alone to get the menu. Changes write fusion.jsonc and apply",
  "to the next request; a toast confirms each one.",
].join("\n");

export default Plugin.define({
  id: "fusion",
  setup(context) {
    const rpc = context.client.rpc(FUSION_RPC);
    const [seen, markSeen] = context.storage.memory("fusion.notices", {
      initial: { ids: {} as Record<string, true> },
    });
    const toast = context.ui.toast;
    const dialog = context.ui.dialog;

    // One toast per notice id, ever. severity -> toast variant.
    const showNotice = (n: {
      id?: string;
      kind?: string;
      severity?: string;
      title?: string;
      message: string;
      action?: string;
      sessionID?: string;
    }) => {
      const id = n.id ?? `${n.kind ?? "notice"}:${n.message}`;
      if (seen.ids[id]) return;
      markSeen((draft) => {
        draft.ids[id] = true;
      });
      toast.show({
        variant: (n.severity as "info" | "success" | "warning" | "error") ?? "warning",
        title: n.title ?? "fusion",
        message: [n.message, n.action].filter(Boolean).join(" "),
        ...(n.sessionID ? { sessionID: n.sessionID } : {}),
      });
    };

    // Live notices from the server plugin.
    rpc.events.on("notice", (event) => {
      showNotice((event?.data ?? event) as Parameters<typeof showNotice>[0]);
    });
    // Backlog: notices that fired before this TUI subscribed (including
    // anything bin/oc-server dropped in the pending file).
    void rpc
      .notices({})
      .then((r) => {
        for (const n of (r as { items?: unknown[] }).items ?? []) {
          showNotice(n as Parameters<typeof showNotice>[0]);
        }
      })
      .catch(() => {});

    // Plugin load failures on the server side surface once, as a notice:
    // a failed plugin is otherwise a silent gap in the harness.
    const location = () => context.location ?? context.data.location.default();
    void context.client.plugin
      .list({ location: location() })
      .then((result) => {
        for (const entry of (result as { data?: unknown[] }).data ?? []) {
          const e = entry as {
            id?: string;
            source?: { type?: string; target?: string; path?: string };
            state?: { status?: string; error?: string };
          };
          if (e.state?.status !== "failed") continue;
          const name = e.id ?? e.source?.target ?? e.source?.path ?? "?";
          showNotice({
            id: `plugin-failed:${name}`,
            kind: "plugin-failed",
            severity: "error",
            title: "plugin failed",
            message: `Plugin "${name}" failed to load${e.state?.error ? `: ${e.state.error.slice(0, 160)}` : "."}`,
            action: "Restart the server, or remove the plugin and retry.",
          });
        }
      })
      .catch(() => {});

    const sessionID = () => {
      const route = context.ui.router.current();
      return route.type === "session" ? route.sessionID : undefined;
    };

    const money = (n: number) => `$${n.toFixed(3)}`;

    const statusText = (st: Record<string, any>) => {
      const lines: string[] = [];
      lines.push(st.banner ?? "");
      lines.push("");
      const b = st.backend ?? {};
      if (b.llamacpp) {
        const l = b.llamacpp;
        lines.push(
          `llama-server  ${l.down ? "DOWN" : l.up ? "up" : "?"}  ${l.url ?? "no endpoint"}` +
            `${l.resident?.length ? `  resident: ${l.resident.join(", ")}` : ""}` +
            `${l.ctx ? `  ctx ${l.ctx}${l.parallel ? `/${l.parallel} slots` : ""}` : ""}` +
            `${l.remote ? "  (remote)" : ""}`,
        );
      }
      if (b.strata) {
        const s = b.strata;
        lines.push(
          `strata        ${s.down ? "DOWN" : s.up ? "up" : "?"}  ${s.url ?? ""}` +
            `${s.live?.model ? `  serving: ${s.live.model}` : ""}` +
            `${s.live?.maxContext ? `  max_ctx ${s.live.maxContext}` : ""}`,
        );
      }
      if (b.fallback?.name) {
        lines.push(
          b.fallback.active
            ? `fallback      ACTIVE: sidekick work is on ${b.fallback.active} until the local backend is back`
            : `fallback      ${b.fallback.name} (standby)`,
        );
      }
      lines.push(
        `graft         ${st.graft?.present ? "index present" : "no graft/ index in this directory"}`,
        `rtk           ${st.rtk?.installed ? "installed" : "not installed"}`,
      );
      if (st.pruneActive) lines.push("prune         active (compaction.prune parity)");
      if (st.stalls?.length) {
        lines.push("", "watch:", ...st.stalls.map((s: string) => `  ${s}`));
      }
      if (st.session) {
        lines.push(
          "",
          `this session  cost ${money(st.session.cost ?? 0)}` +
            (st.session.freeLead
              ? "  (free lead: delegation saves rate-limit budget, not money)"
              : `  delegated work would have cost ${money(st.session.shadowCost ?? 0)} at lead rates`),
        );
      } else {
        lines.push("", "no session open: session cost shows when one is active");
      }
      lines.push(`all time      cost ${money(st.totals?.cost ?? 0)}  shadow ${money(st.totals?.shadowCost ?? 0)}`);
      const dropped = st.dropped ?? {};
      if (dropped.unaudited?.length) {
        lines.push("", `v2 ignores these config keys (they do nothing):`);
        for (const k of dropped.unaudited) lines.push(`  ${k}`);
      }
      if (dropped.audited?.length) {
        lines.push("", "v2 ignores these keys on purpose (v1-only or covered by the plugin):");
        for (const k of dropped.audited) lines.push(`  ${k}`);
      }
      return lines.join("\n");
    };

    const runSubcommand = async (input?: string) => {
      const args = String(input ?? "").trim().split(/\s+/).filter(Boolean);
      const sub = args[0] ?? "";
      const direct = args.slice(1).join(" ").trim();

      if (!sub) {
        const picked = await dialog.select({
          title: "/fusion",
          options: MENU,
          placeholder: "pick a control",
        });
        if (!picked) return;
        return runSubcommand(picked);
      }
      if (sub === "help") {
        await dialog.alert({ title: "/fusion help", message: HELP });
        return;
      }
      if (sub === "status") {
        toast.show({ message: "gathering fusion status…", variant: "info" });
        const st = await rpc.status({ sessionID: sessionID() }).catch((e: { message?: string }) => {
          toast.show({ variant: "error", title: "fusion", message: `status failed: ${e?.message ?? e}` });
          return null;
        });
        if (st) await dialog.alert({ title: "fusion status", message: statusText(st) });
        return;
      }
      if (sub === "doctor") {
        toast.show({ message: "running oc-fusion doctor…", variant: "info" });
        const r = await rpc.doctor({}).catch((e: { message?: string }) => {
          toast.show({ variant: "error", title: "fusion", message: `doctor failed: ${e?.message ?? e}` });
          return null;
        });
        if (r) await dialog.alert({ title: "oc-fusion doctor", message: (r as { text?: string }).text ?? "no output" });
        return;
      }
      if (sub === "effort") {
        const r = (await rpc.choices({ key: "effort" }).catch(() => null)) as {
          seats?: { seat: string; current: string; options: { value: string; title: string }[] }[];
        } | null;
        if (!r?.seats?.length) {
          toast.show({ variant: "error", title: "fusion", message: "effort choices unavailable: is the fusion server plugin loaded?" });
          return;
        }
        const seat = await dialog.select({
          title: "/fusion effort — pick a seat",
          options: r.seats.map((s) => ({ value: s.seat, title: s.seat, description: `now: ${s.current}` })),
          current: direct || undefined,
        });
        if (!seat) return;
        const wanted = r.seats.find((s) => s.seat === seat);
        const level = await dialog.select({
          title: `/fusion effort ${seat}`,
          options: (wanted?.options ?? []).map((o) => ({ value: o.value, title: o.title })),
          current: wanted?.current,
        });
        if (!level) return;
        return applySet(`local_efforts.${seat}`, level);
      }
      // Every other subcommand is a panel knob.
      const known = MENU.some((m) => m.value === sub);
      if (!known) {
        toast.show({ variant: "warning", title: "fusion", message: `"/fusion ${sub}" is not a command. Try /fusion help.` });
        return;
      }
      const r = (await rpc.choices({ key: sub }).catch(() => null)) as {
        label?: string;
        help?: string;
        current?: string;
        options?: { value: string; title: string; description?: string; footer?: string }[];
        error?: string;
      } | null;
      if (!r || r.error || !r.options?.length) {
        toast.show({ variant: "error", title: "fusion", message: r?.error ?? `"/fusion ${sub}" is unavailable: is the fusion server plugin loaded?` });
        return;
      }
      const value =
        direct ||
        (await dialog.select({
          title: `/fusion ${sub} — ${r.label ?? sub}`,
          options: r.options.map((o) => ({
            value: o.value,
            title: o.value === r.current ? `${o.title}  (current)` : o.title,
            description: o.description,
            footer: o.footer,
          })),
          current: r.current,
        }));
      if (!value || value === r.current) return;
      return applySet(sub, value);
    };

    const applySet = async (key: string, value: string) => {
      const r = (await rpc.set({ key, value }).catch((e: { type?: string; message?: string }) => ({
        error: e?.message ?? String(e),
      }))) as { applied?: boolean; note?: string; error?: string };
      if (!r?.applied) {
        toast.show({ variant: "error", title: "fusion", message: r?.error ?? `could not set ${key}` });
        return;
      }
      toast.show({
        variant: "success",
        title: "fusion",
        message: `${key} is now "${value}". ${r.note ?? "Applies to the next request."}`,
      });
    };

    context.ui.slot({
      append: "app",
      render() {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "fusion.panel",
              title: "Fusion controls",
              description: "Panel, backends, effort and escalation for the oc-fusion harness",
              group: "Fusion",
              palette: true,
              slash: { name: "fusion", arguments: true },
              run: runSubcommand,
            },
          ],
        }));
        return null;
      },
    });
  },
});
