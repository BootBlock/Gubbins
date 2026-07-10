# Tool tracking as a use-case — backlog (living plan)

A grouped backlog for making Gubbins a good **tool tracker** (drills, torque wrenches, the bench
vice, hire-out kit) **without** adding a first-class "Tool" entity. The finding from the scoping
pass is that Gubbins *already* models everything a dedicated tool tracker needs — serialised
instances, condition, maintenance/calibration schedules, warranty, checkout/loan, QR labels, kits —
so this backlog is deliberately **thin**: a convenience layer on top of the existing model plus a
few genuine rough edges in the loan flow, not a new subsystem.

Implement **one task at a time** in separate sessions; each task has a stable ID (`T1`, `T2`, …) so
a session can be kicked off with just "implement `T2`".

**Origin:** scoping question "is it worth adding support for tools?" — the answer being *the
primitives already cover it, so only presets + loan-flow polish are worth chasing.* The asset-facet
primitives live in [constants.ts](../../src/db/repositories/constants.ts) (`TRACKING_MODES`,
`CONDITIONS`, `MAINTENANCE_BASES`, `CHECKOUT_STATUSES`, the `CHECKED_OUT`/`CHECKED_IN`/
`MAINTENANCE_LOGGED`/`CONDITION_CHANGED`/`TESTED` history actions). The loan lifecycle lives in
[CheckoutRepository.ts](../../src/db/repositories/CheckoutRepository.ts) +
[CheckoutDialog.tsx](../../src/features/contacts/components/CheckoutDialog.tsx).

**House rules that apply to every task below** (see [CLAUDE.md](../../CLAUDE.md)): design tokens
only, reach for a Foundry primitive before hand-rolling, keep a11y wiring (labels, roles, live
regions), verify token-based Tailwind utilities actually emit, and do the work in a worktree.

**Explicitly out of scope** (from the feature-gap audit): multi-user accounts, roles/permissions,
chain-of-custody signatures, EULA-on-checkout. Those pull in a user/identity model the app
deliberately doesn't have. A "tool" is just a serialised asset that gets loaned; it is not a new
security boundary.

---

## A. Category templates (the one convenience worth adding)

The gap: a category today is only a **name + a list of custom fields**
([types/categories.ts](../../src/db/repositories/types/categories.ts)). It carries **no defaults for
the built-in facets** — tracking mode, condition, maintenance schedule, checkout-eligibility,
warranty. So a user who wants "every tool is a serialised asset with a 12-month calibration
schedule, checkout enabled" has to hand-assemble that on the create form **every single time**
([CreateItemDialog.tsx](../../src/features/inventory/components/CreateItemDialog.tsx) already takes
`categoryId` and `trackingMode` as *independent* fields — picking "Tools" changes nothing about the
tracking mode or lifecycle defaults today).

A category template closes that: choosing a category **pre-fills** the built-in facet fields with
that category's defaults, which the user can still override per item. This is a general
"category defaults" feature that happens to make tools (and any asset class — cameras, test gear,
musical instruments) pleasant; it is **not** tool-specific code.

- **T1 — Category default tracking mode. ✅ Shipped 2026-07-10.** Added an optional
  `default_tracking_mode` column to `categories` (folded into the v1 baseline per
  [[migration-baseline-squashed]]; golden snapshot regenerated), threaded through
  `Category`/`CategoryRow`/`CreateCategoryInput`/`UpdateCategoryInput`, the row→DTO mapper and
  `CategoryRepository` create/update (a plain LWW column, no history action, constrained to the
  `TRACKING_MODES` SSOT by a CHECK mirroring `items.tracking_mode`). `CreateItemDialog` now
  *soft*-prefills the Tracking field from the selected category's `defaultTrackingMode`: a
  `trackingModeTouched` ref flips true on any manual Tracking change, so a category (re)selection
  never re-stomps a mode the user picked. No editor UI yet (that's T3).

- **T2 — Category default facets (condition / warranty / maintenance).** Extend the template to the
  Phase-9 lifecycle facets: a default `condition`, a default maintenance schedule
  (`MAINTENANCE_BASES` + interval), optionally a default warranty window. Same soft-prefill
  semantics as T1. This is what turns "new Tool" into "serialised + Good + 12-month calibration"
  in one category pick. Reuses the existing lifecycle form fields — no new inputs, just defaulted.

- **T3 — Template editor UI.** Surface the T1/T2 defaults in the existing
  [CategoryManagerDialog](../../src/features/inventory/components/CategoryManagerDialog.tsx) /
  `CreateCategoryDialog`, next to the custom-field editor, as a "Defaults for new items in this
  category" section. Keep it a `FormField` stack with the same tokens/gaps as the rest of the
  dialog. Do **after** T1/T2 so there's something to edit.

- **T4 — Seed a "Tools" starter template (optional).** A one-tap "Add a Tools category" affordance
  (e.g. in first-run or the empty category list) that creates a category pre-wired with the T1/T2
  defaults and a couple of tool-ish custom fields (e.g. serial number, calibration cert URL). Pure
  convenience / discoverability; lowest priority. Keep the seed data synthetic and generic.

**Why not a first-class "Tool" type?** It would duplicate the `TRACKING_MODES` × facet design,
fork the codebase into "tools vs items" for every list/filter/report, and buy nothing the template
approach doesn't. The template is additive and reversible; a new entity is neither.

---

## B. Loan-flow rough edges (surfaced by the tool use-case)

Walking the checkout flow specifically for tools (a tool is the *canonical* thing you loan) turned
up these rough edges. B1 is a genuine data-loss bug; the rest are enhancements. Ordered by value.

- **B1 — Return note clobbers the loan note (data loss). ✅ Shipped 2026-07-10.** `checkIn` used to
  do `note = COALESCE(?, note)` on the **same `checkouts` row** that stored the checkout note, so a
  return note overwrote the original loan note (e.g. "for the Henderson job" → "returned with chipped
  blade"). Fixed by adding a `return_note` column (folded into the v1 baseline; golden snapshot
  regenerated) and writing the return remark there; both ends of the loan now keep their own text,
  exposed as `Checkout.returnNote`. **✅ Rider done (with B2):** both the loan note and the return
  note now surface in the contact's **Loan history** section in `EditContactDialog`; the loan note
  also shows on the open-loan row.

- **B2 — No condition capture on return. ✅ Shipped 2026-07-10.** A returned tool is frequently in a
  *different* condition (blunt, chipped, now due calibration), but `checkIn` only took an optional
  note. Added a `CheckInDialog` (opened from the "Return" affordance) that optionally captures a
  **condition on return** (reusing `conditionSelectOptions`) and a **return note**; `checkIn` now
  takes a `CheckInOptions` object (`{ note?, condition? }`) and, when a condition is supplied *and*
  differs from the item's current one, updates `items.condition` and logs `CONDITION_CHANGED`
  alongside `CHECKED_IN` in the same transaction. An empty submit is unchanged from the old one-tap
  return. (Maintenance-flag triggering was left to B3/maintenance work — out of scope here.)

- **B3 — Can't extend/renew a loan.** To change a due date you must check the tool in and back out
  again (losing the loan's continuity and its original checkout timestamp). Add a "renew / change
  due date" action that updates `due_date` on the open checkout in place and logs it. Common for
  long-running tool loans.

- **B4 — Loans are to a contact only, never to a project/location.** A tool is often "out on the
  Henderson job" or "in the van", not lent to a named person. Today the only borrower is a
  `Contact` (a person), so users end up creating pseudo-contacts named after jobs/vehicles. Consider
  allowing a loan target of a **project** (or a location) as a first-class alternative to a contact.
  Larger — it touches the `checkouts` schema and the resolve-or-create path — so scope it carefully;
  the pseudo-contact workaround is tolerable in the meantime. Lower priority than B1–B3.

- **B5 — Untracked assets can't be loaned (by design) — document the escape hatch.** `checkout`
  deliberately rejects `UNTRACKED` items ("use a serialised item for assets that are checked out")
  and the "Loan out…" action is hidden for them
  ([ItemActions.tsx](../../src/features/inventory/components/ItemActions.tsx) ~L122). That's the
  right call, but there's no in-product nudge telling a user *why* the bench-vice they marked
  Untracked can't be loaned, or offering the in-place `UNTRACKED → DISCRETE` convert
  ([[item-model-parallel-lists]]). A small hint/CTA, not a model change. Lowest priority.

---

## Suggested order

~~`B1` (bug)~~ ✅ → ~~`T1`~~ ✅ → `T2` → ~~`B2`~~ ✅ → `T3` → `B3` → then reassess `B4` / `T4` / `B5` by appetite.
