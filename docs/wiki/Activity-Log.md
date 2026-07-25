# Activity log

Gubbins keeps a **chronological ledger of every change** to your inventory — what happened, to
what, and when. It's your audit trail and your undo-history-of-record.

**Where to find it:** the **Activity** screen (a global feed), and the **Activity** tab on any
individual item.

![The Activity ledger, newest first](images/activity.png)

## What gets recorded

Just about every meaningful change is logged: creating and editing items, stock adjustments,
[[moves and transfers|Locations-and-Stock]], [[loans out and returns|Loans-Check-Out-and-In]],
[[sales and write-offs|Sales-and-Disposals]], [[cycle-count reconciliations|Cycle-Counts-and-Audit-Day]],
revaluations, servicing, and more.

Every entry is also recorded against **who** made it. On a single-person setup that's always the
built-in **Admin** account, so it isn't something you need to think about. Turn on
[[accounts|Users-and-Accounts]] and each entry carries the name of the person who made the change
instead.

- The **global Activity feed** shows everything across your inventory, newest first.
- Each **item's Activity tab** shows just that item's history — a complete story of one thing.

Editing an item's details is recorded too, as a single **Details changed** entry naming what you
changed: its price (unit cost, purchase price or current value), barcode, serial number,
manufacturer and manufacturer part number, category, batch and lot numbers,
[[reorder thresholds|Low-Stock-and-Gauges]], expiry, acquisition and warranty dates, depreciation
period, weight and dimensions — alongside the renames, tracking-mode switches and condition changes
that have always been logged.

> **ℹ️ Note**
> A few things change quietly. The free-text description, notes and **operational parameters** do,
> because keeping a copy of long text on every edit would bloat a log that syncs to your other
> devices — as do [[custom-field values|Custom-Fields-and-Capabilities]]. So do the **favourite**
> pin and the dead-stock and unlimited-supply toggles, which are display and reporting preferences
> rather than changes to what the item is. Saving a form without actually changing anything records
> nothing at all.

> **💡 Tip**
> The Activity log is the fastest way to answer *"what changed, and when did that happen?"* — if a
> count looks wrong, its item's history usually shows exactly what led to it.

> **ℹ️ Note**
> The log can grow large over time. If you need to reclaim space, old history can be pruned (with
> a cold-storage export first) from the [[storage triage|Storage-Triage]] tools — nothing is lost
> without a copy.

## Related pages

- **[[Alerts]]** — things that need action now.
- **[[Upcoming agenda|Upcoming-Agenda]]** — things due soon.
- **[[Storage triage|Storage-Triage]]** — managing history size.
