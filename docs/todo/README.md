# `docs/todo/` — plan & effort logs

> **Status:** 📘 REFERENCE — defines the status convention for every document in this folder.

These are working documents: phased plans, feature backlogs, audits and feasibility studies.
They are **not** user-facing documentation — that lives in [`docs/wiki/`](../wiki). They are also
**not** a description of how the app currently behaves; a plan records what was intended at the
time it was written, which may since have changed.

Because they are long-lived and world-readable, a reader must be able to tell **at a glance**
whether a document still describes live work. That is what the status banner is for.

## The rule

Every `.md` file in this folder (including `done/`, excluding this README's own siblingless
case — it carries one too) **must** begin with a status banner as the first line after the `#`
heading:

```markdown
# My feature — implementation plan

> **Status:** 🟢 ACTIVE — open backlog; phases 1–2 shipped, phase 3 next.
```

A unit test enforces this ([`src/lib/docs-todo-status.test.ts`](../../src/lib/docs-todo-status.test.ts)),
so a missing or misfiled banner fails the build rather than review.

## The four statuses

| Status | Meaning | Lives in |
| --- | --- | --- |
| `🟢 ACTIVE` | Live work. Someone may pick this up next; the content is expected to be current. | `docs/todo/` |
| `📘 REFERENCE` | The work is done, but the document is deliberately kept as durable reference (a format spec, a feasibility survey and its verdicts). | `docs/todo/` |
| `✅ COMPLETE` | The work shipped. Kept for the design rationale and the record of *why*, not as current guidance. | `docs/todo/done/` |
| `⛔ SUPERSEDED` | Overtaken by later work. Retained for historical context only — **do not** treat as current. | `docs/todo/done/` |

Keep the one-line summary after the dash specific and factual — which phases shipped, what is
next. Don't state a completion date you haven't verified; omit it instead.

## Moving a document

When an effort finishes, change its banner to `✅ COMPLETE` and `git mv` it into `done/` in the
same change. Grep for inbound links first (`docs/dev/deferred-features.md` and
`docs/dev/PHASE_HANDOVER.md` reference these plans by path) and update them, or the move leaves
dangling references behind.

Deleting a finished log is also fine where it carries nothing durable — but prefer archiving,
since the *why* behind a decision is usually the part worth keeping.
