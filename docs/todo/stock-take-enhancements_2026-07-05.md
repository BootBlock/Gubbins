# Stock-take (audit day) enhancements — backlog (living plan)

> **Status:** 🟢 ACTIVE — open backlog; G1 shipped, F1 next.

A grouped backlog of cycle-count / stock-take enhancements, to be implemented **one task at a
time** in separate sessions. Each task has a stable ID (`F1`, `F2`, …) so a session can be kicked
off with just "implement `F2`".

**Origin:** grounding research into how hobbyist-through-enterprise inventory apps (Sortly,
Snipe-IT/EZOfficeInventory, inFlow, Zoho Inventory, Odoo Inventory, Cin7, Fishbowl, NetSuite,
SAP EWM, Manhattan) actually run a physical stock-take, compared against Gubbins' existing
`CycleCountDialog` + `AuditDayDialog` engine (spec §4.4). The list below is already filtered down
to what's worth chasing for a **personal/home inventory** app — enterprise-only concerns (GL
posting/approval chains, forklift-directed counts, double-blind counting, printable count sheets)
are deliberately excluded; see "Explicitly out of scope" at the bottom.

**Current engine (don't re-fork):** one shared per-location count → variance → reconcile engine
(`useLocationCycleCount` + `CycleCountLines`), driven by both the standalone `CycleCountDialog`
and the guided `AuditDayDialog` stepper. Blind count today: DISCRETE lines get a typed quantity
with a live variance chip; SERIALISED instances get a binary Present/Missing toggle.
Reconciliation writes one `ReconciliationAdjustment` per drifted batch line and a reversible
soft-delete per missing instance. The audit-day walk (scope picker → stepper → summary) is
resumable via the persisted `useAuditSessionStore`, but that store — and the whole audit
outcome — is discarded once the walk is abandoned/done; nothing survives into a durable history.
See `[[cycle-count-and-audit-day]]` memory for the full architecture map.

**House rules that apply to every task below** (see `CLAUDE.md`): design tokens only, reach for a
Foundry primitive before hand-rolling, keep a11y wiring (labels, roles, live regions), and verify
token-based Tailwind utilities actually emit.

---

## F. Scan-driven counting

- **F1 — Barcode/QR scan-to-count.** Wire the app's existing barcode-scan capability (used
  elsewhere for item entry) into `CycleCountLines`: scanning an item's barcode during a count
  increments/confirms its counted quantity (or toggles a SERIALISED instance present) instead of
  requiring a typed number. This is the single highest-leverage UX gap versus every consumer-tier
  competitor (Sortly, inFlow, Zoho) — typed-quantity-only counting is the exception, not the norm,
  once an app already has barcodes on items. Should layer on top of the existing count state
  (`setCount`/`setPresence`) rather than replace it — typing stays available as a fallback for
  unlabelled items.

## G. Durable count history

- **G1 — Persist a "last counted" timestamp per location (and surface it). ✅ Done.**
  `locations.last_counted_at` (nullable epoch-ms) added to the v1 baseline; `LocationRepository
  .markCounted()` stamps it, called from `useLocationCycleCount.authorise()` — which now runs
  unconditionally (clean counts included) rather than only when there are variances, closing a
  gap where a clean standalone count previously had no "done" affordance (`CycleCountDialog`'s
  Authorise button was disabled at zero variances). `AuditDayDialog`'s clean/variance/empty
  "finish this location" paths were consolidated onto the same `authorise()` call so every
  non-skip completion stamps the timestamp. Surfaced in `LocationInfoCard` (a "Last counted"
  stat, `xl:` breakpoint) and in the audit-day scope picker's "choose specific locations" list
  (relative time / "Never counted" per row). This is the foundation the rest of group G builds on.
- **G2 — Historical audit log / trend view.** Once G1 exists, a simple "count history" screen or
  report: past stock-takes, per-location variance trend over time, accuracy-over-time. Keep it
  read-only and derived from the reconciliation ledger (already the durable record of *what*
  changed) plus the new `lastCountedAt` — don't stand up a second parallel history table if the
  existing ledger can be queried instead.
- **G3 — Structured discrepancy reason.** Replace/augment the generated free-text reconciliation
  note with a structured reason tag (damage / theft / miscount / expired / data-entry-error) the
  auditor picks when a variance is found, so patterns become queryable later ("what keeps going
  missing from the garage?"). Optional field — don't force a reason on every trivial ±1 variance.

## H. Recount & tolerance

- **H1 — Variance-tolerance threshold before auto-accept.** A Tier-2 preference (clamp + bounds,
  matching the existing "const → Tier-2 preference" pattern) for a tolerance (e.g. ±1 unit or
  ±2%); variances within tolerance authorise as today, variances beyond it prompt a recount step
  ("count again to confirm") before the adjustment is accepted. Fits the existing engine without
  new plumbing — the recount is just a second pass through the same count input before
  `authorise()` is enabled for that line.

## I. Serialised-item nuance

- **I1 — A third presence state beyond Present/Missing.** Asset-tracking tools (Snipe-IT,
  EZOfficeInventory) don't force a binary here — an item that's legitimately checked out/on
  loan/in transit isn't "missing," it's accounted for elsewhere. Add a state (e.g. "elsewhere") so
  the presence audit doesn't manufacture a false-missing for something already tracked as loaned.
  Depends on whatever loan/checkout/booking concept currently exists for serialised items (see
  `[[cycle-count-and-audit-day]]` and the bookings feature) — confirm the mapping before building.

## J. Scheduling & habit-forming

- **J1 — Recurring stock-take reminders.** "Audit the garage every 90 days" — a per-location (or
  global) cadence preference that surfaces a dashboard/notification nudge when a location is
  overdue (built on G1's `lastCountedAt`). This turns the feature from purely manual into a
  habit-forming one, which matters more for a home-inventory app (things get forgotten) than for
  a business with a dedicated stock-take schedule already.

---

## Suggested starting points

G1 shipped 2026-07-05. Next up: **F1** (barcode scan-to-count — biggest single UX win), then
**H1** (variance tolerance/recount).

## Explicitly out of scope (enterprise-only, doesn't fit a home-inventory app)

- Double-blind counting (two independent counters reconciled against each other) — Gubbins is
  already single-blind (expected qty hidden until entry), which is the right level here.
- Count-freeze / inventory lock during a count — real risk in a multi-worker warehouse with
  concurrent transactions; a non-issue for a single/few-user home app.
- ABC-classification-driven count frequency, opportunity/directed counts — genuinely valuable at
  warehouse scale, not proportionate here; revisit only if per-item "attention" scaling
  (`[[inventory-attention-scaling-ceiling]]`) grows a natural hook for it.
- Printable/exportable count sheets, GL posting / approval chains — no paper workflow, no ledger
  system, in Gubbins.

## Working notes for whoever picks one up

- Confirm exact preference placement (Settings → Inventory, presumably) and any new terms
  ("elsewhere", tolerance %) with the developer before building H1/I1/J1 — user-facing copy.
- Keep the shared engine shared: every task here should extend `useLocationCycleCount` /
  `CycleCountLines` / `audit-session.ts`, not fork logic between `CycleCountDialog` and
  `AuditDayDialog`.
- G2 should query the existing reconciliation ledger rather than invent a parallel history store.
