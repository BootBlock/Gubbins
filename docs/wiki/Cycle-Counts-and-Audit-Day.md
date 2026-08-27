# Cycle counts & audit day

However careful you are, recorded stock drifts from reality — things get used, moved or
miscounted. **Cycle counting** is the routine of checking on-hand quantities against what's
actually on the shelf and reconciling the difference, so your numbers stay honest.

**Where to find it:** the **Cycle count** action in the Inventory **More** menu, once the **Cycle
counts** capability is enabled ([[Modular UI|Modular-UI]]); the guided **audit day** sits beside it
and walks multiple locations in turn.

## Counting a location

A cycle count works **per location**: Gubbins lists what it *thinks* is there, you enter what's
*actually* there, and it reconciles the difference — adjusting stock and recording the change in
the [[activity log|Activity-Log]]. Counting one area at a time (rather than the whole inventory
at once) keeps it manageable and is exactly how "cycle" counting is meant to work.

Counts handle every stock style:

- **Bulk** — a quantity per location.
- **Serialised** — presence of each unit (including ones that are [[elsewhere on
  loan|Loans-Check-Out-and-In]]).
- **[[Batches|Batches-and-Lots]]** — per-batch quantities.

> **💡 Tip**
> Cycle count a few high-value or fast-moving locations regularly rather than the whole place
> rarely — you catch drift sooner and it's never a big job.

## Your counts are kept if you stop partway

Counting happens away from the desk, and you *will* be interrupted. Whatever you've typed into a
count is **saved as you go**, so closing the dialog — deliberately, by tapping outside it, or
because your phone put the tab to sleep — doesn't cost you the shelf. Reopen that location and the
numbers come back, with a note saying how many were restored and when you entered them.

Nothing is written to your inventory until you **authorise** the count, so a saved count is still
just a working sheet. If you'd rather recount from scratch, **Start over** on that note clears it.

> **⚠️ Heads-up**
> A restored count is only as good as the shelf still is — check it before authorising if some
> time has passed. Gubbins only ever hands back the numbers **you** typed; it never fills in what
> it expects to find, so the count stays honest.

Once a location is authorised or skipped, its saved counts are cleared — and abandoning a
stock-take discards them for every location in the walk.

## A part-counted location says so

Leaving a line blank is not the same as counting it and finding nothing wrong, so Gubbins never
treats it as such. A blank line is left completely alone — its stock is not touched — and the
count sheet tells you how much of it you have covered as you go: **"12 of 40 lines counted"** sits
alongside the number of adjustments waiting to be authorised.

Finish with lines still blank and the button says so — **Record partial count** in a single-location
count, **Record partial & continue** on audit day, rather than **Mark counted** — and the location
keeps its existing **last counted** date rather than gaining a fresh one. The lines you *did*
count are still applied; only the claim that the whole location has been checked is withheld.

> **⚠️ Heads-up**
> That last-counted date is what tells you which places are overdue. A shelf recorded as counted
> when half of it was never looked at drops off that list, which is worse than one that was never
> counted at all — so a partial count deliberately leaves it stale, and the location stays on the
> list until you finish it.

On [[audit day|#audit-day]] a part-counted location gets its own **Partial** figure in the final
summary, and is named in a **Part-counted — still need a count** list, so you know exactly where
to go back to.

> **ℹ️ Note**
> This covers the per-location quantity lines. Serialised units are audited by presence and start
> as **Present**, so they carry no blank state to report.

## Counting the same shelf on two devices

Two people can count the same place at once — a phone each on audit day, or a count in the garage
followed by a check at the desk — without the two counts fighting each other. A count is a
statement about what's *there*, not a change to what's there, so counting a shelf twice is not
"minus two, twice": once the devices [[sync|Cloud-Sync]] they settle on what was counted, and if
the two counters disagreed, the **later** correction is the one that stands.

Anything genuinely used or received *after* a count is still applied on top of it, so a count sets
a fresh starting point rather than freezing the shelf. This works per line: a count of a
[[lot|Batches-and-Lots]] settles that lot.

## Audit day

For a full stock-take, the guided **audit day** walks you through your locations one by one,
tracking progress as you go so you can pause and resume without losing your place. **Pause &
close** keeps both: where you'd got to in the walk, *and* the counts you'd entered at the location
you were on. It's built on the same per-location counting engine, so a single location count and a
full audit feel the same.

> **ℹ️ Note**
> Gubbins remembers when each location was **last counted**, so you can see what's overdue for a
> check and prioritise it. The built-in **Unassigned** location is the one exception — you can
> count the loose stock sitting there, but it doesn't carry a last-counted date of its own.

## Hiding stock-taking

If you never count, switch the **Cycle counts** capability off under [[Modular UI|Modular-UI]].
Both entry points leave the Inventory **More** menu, the **Last counted** figure disappears from
the location summary, and the **Never counted** check drops out of the
[[data-hygiene checklist|Data-Hygiene]] — there would be no way to clear it.

Nothing is deleted. Counts you have already authorised stay in the [[activity
log|Activity-Log]], the stock they set stays as it is, and every last-counted date comes back if
you switch the capability on again.

## Related pages

- **[[Locations & stock|Locations-and-Stock]]** — the per-location ledger being reconciled.
- **[[Batches & lots|Batches-and-Lots]]** — per-batch counting.
- **[[Activity log|Activity-Log]]** — where reconciliations are recorded.
- **[[Modular UI|Modular-UI]]** — hiding stock-taking on a device that never counts.
