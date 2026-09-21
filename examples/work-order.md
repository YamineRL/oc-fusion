---
# Required. The filename in .fusion/inbox/ is derived from this.
id: example-order
# Required. Which seat filed this: chief-of-staff, engineering-lead, ...
seat: engineering-lead
# Optional, shown in `work_order list`.
title: Example work order
# Optional free-form fields your seats may add: priority, deadline, blocked_by.
priority: normal
---

## Objective

One paragraph: what "done" is. Not a procedure; the harness decides how.
A work order states the outcome; the seats' job is to make it executable.

## Scope

What is in play: directories, files, systems. And just as important, what is
explicitly out. The harness treats out-of-scope as a boundary, not a hint.
Example: "src/auth/ only; no schema changes; do not touch the billing path."

## Acceptance

The checks that make it done, stated as commands and expected results so the
harness can verify without judgment:

- `npm test` exits 0
- `tests/seat-holds.test.ts` passes
- the /ops page renders the new column

A green acceptance check is also what resets the stall counters: an order
without one has no way to prove it is not looping.

## Constraints

Anything the runtime should respect that the brief cannot grant: spend limits,
no external calls, do-not-publish. Note that authority does not transfer with
the file: money, publishing, deploys and external contact still wait for the
owner regardless of what this section says.
