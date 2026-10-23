// Slot gate: one session at a time on a one-slot local backend.
//
// Strata (and llama-server with --parallel 1) keeps the prompt cache of
// the LAST request only. Under v2 a subagent runs in the background, so
// the lead keeps sending requests while its child works. Two sessions on
// one slot then take turns, and each request removes the other's cache:
// every request reads its whole prompt again from 0. On 2026-10-09 a lead
// (65k tokens) and its grunt (14k tokens) did this for two hours, and no
// request finished before the client timeout.
//
// The gate gives the backend to one session (the owner) until that
// session's execution ends. Rules, in order:
//   1. No owner, or the caller is the owner: go.
//   2. The caller is a descendant of the owner (a subagent of it): the
//      child takes the backend. The parent waits until the child ends.
//   3. Else wait. When the owner ends, the deepest waiter goes first
//      (children before parents), then the oldest.
// An owner that shows no activity for idleMs is treated as gone (a lost
// end event must not lock the backend). A waiter that waits maxWaitMs
// goes anyway, so the gate can delay a request but never block it forever.
//
// Pure logic: the plugin feeds it session events and awaits acquire() in
// the model.request hook, before opencode starts its request timer.

export function makeSlotGate({
  now = () => Date.now(),
  idleMs = 15 * 60_000,
  maxWaitMs = 60 * 60_000,
  pollMs = 5_000,
  onWait = () => {},
  onGrant = () => {},
} = {}) {
  const parents = new Map(); // sessionID -> parentID
  const active = new Set(); // sessions with a running execution
  const lastSeen = new Map(); // sessionID -> ms of last activity
  const endedAt = new Map(); // sessionID -> ms of last execution end
  const leases = new Map(); // backend -> { owner, waiters: [{ sid, since, wake }] }

  const lease = (backend) => {
    if (!leases.has(backend)) leases.set(backend, { owner: null, waiters: [] });
    return leases.get(backend);
  };

  const depth = (sid) => {
    let d = 0;
    for (let p = parents.get(sid); p && d < 64; p = parents.get(p)) d++;
    return d;
  };

  // True when `anc` is a strict ancestor of `sid`.
  const isAncestor = (anc, sid) => {
    let p = parents.get(sid);
    for (let i = 0; p && i < 64; i++, p = parents.get(p)) if (p === anc) return true;
    return false;
  };

  // A number, or a function read on each check so a profile edit applies live.
  const maxWait = () => (typeof maxWaitMs === "function" ? maxWaitMs() : maxWaitMs);

  const stale = (sid) => now() - (lastSeen.get(sid) ?? 0) > idleMs;

  // Pick the next owner among the waiters: deepest first, then oldest.
  const handOver = (backend) => {
    const L = lease(backend);
    L.owner = null;
    const live = L.waiters.filter((w) => !w.gone);
    if (!live.length) return;
    const next = live.sort((a, b) => depth(b.sid) - depth(a.sid) || a.since - b.since)[0];
    L.owner = next.sid;
    lastSeen.set(next.sid, now());
    for (const w of L.waiters) w.wake();
  };

  const release = (sid) => {
    for (const [backend, L] of leases) if (L.owner === sid) handOver(backend);
  };

  return {
    created(sid, parentID) {
      if (sid && parentID) parents.set(sid, parentID);
    },
    started(sid) {
      active.add(sid);
      lastSeen.set(sid, now());
    },
    activity(sid) {
      if (sid) lastSeen.set(sid, now());
    },
    ended(sid) {
      active.delete(sid);
      endedAt.set(sid, now());
      // A waiter of this session will not send its request: wake it so it
      // leaves, and keep it out of the handover below.
      for (const L of leases.values()) {
        for (const w of L.waiters) if (w.sid === sid) { w.gone = true; w.wake(); }
      }
      release(sid);
    },

    owner(backend) {
      return lease(backend).owner;
    },
    waiting(backend) {
      return lease(backend).waiters.map((w) => w.sid);
    },

    // Resolves when `sid` may send a request to `backend`.
    // { waitedMs, reason: "free"|"owner"|"child"|"handover"|"stale"|"timeout"|"ended" }
    async acquire(backend, sid) {
      const L = lease(backend);
      const t0 = now();
      const take = (reason) => {
        L.owner = sid;
        active.add(sid);
        lastSeen.set(sid, now());
        const waitedMs = now() - t0;
        if (waitedMs > 0 || reason !== "free") onGrant({ backend, sid, reason, waitedMs });
        return { waitedMs, reason };
      };
      if (!L.owner) return take("free");
      if (L.owner === sid) return take("owner");
      if (isAncestor(L.owner, sid)) return take("child");

      onWait({ backend, sid, owner: L.owner });
      const me = { sid, since: t0, gone: false, wake: () => {} };
      L.waiters.push(me);
      try {
        for (;;) {
          await new Promise((resolve) => {
            me.wake = resolve;
            setTimeout(resolve, pollMs).unref?.();
          });
          // The session was interrupted or ended while it waited: its
          // request will not be sent, so it must not take the backend.
          if (me.gone || ((endedAt.get(sid) ?? -1) >= t0 && !active.has(sid))) return { waitedMs: now() - t0, reason: "ended" };
          if (L.owner === sid) return take("handover");
          if (!L.owner) return take("free");
          if (isAncestor(L.owner, sid)) return take("child");
          if (stale(L.owner)) return take("stale");
          if (now() - t0 >= maxWait()) return take("timeout");
        }
      } finally {
        L.waiters.splice(L.waiters.indexOf(me), 1);
      }
    },
  };
}
