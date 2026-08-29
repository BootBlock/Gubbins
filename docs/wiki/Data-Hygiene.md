# Data hygiene

Reports and valuations are only as good as the data behind them. The **data-hygiene** report
surfaces **incomplete records** — items missing the details that make everything else work — so
you can tidy them up.

**Where to find it:** the **Reports** screen.

## What it checks

Data hygiene flags records with gaps that undermine other features, such as items missing:

- A **price** (needed for [[valuation and spend|Valuation-and-Spend]] and the
  [[insurance schedule|Insurance-and-Estate-Schedule]]). Any source valuation uses counts — a
  manual [[current value|Current-Value-and-Revaluation]], a unit cost, a supplier price or a
  purchase price — so an item is only flagged when *nothing* prices it.
- A **location** (so you actually know where it is).
- A **category** or a **photo**.
- Stock that's **never been counted**, or a record that's gone **stale** (untouched for a long time).
- **Possible duplicates** — two items sharing the same manufacturer part number (MPN), the usual
  sign of the same part entered twice. To go further — matching on names, barcodes and serial
  numbers too, and merging what you find — use [[Deduplicating items|Deduplicating-Items]].

Each check reads as a green tick when everything's healthy, or lists the items that need attention.
**Click a flagged item** to jump straight to it — Gubbins opens its card in the
[[inventory|Items]] so you can fix the gap on the spot, no hunting required.

It's a to-do list for keeping your catalogue trustworthy — work through the flagged items and the
gaps close.

> **💡 Tip**
> Run data hygiene after a big [[import|Export-and-Import]] — bulk-imported data often lands with
> gaps, and this is the fastest way to find and fix them (often with a [[bulk edit|Bulk-Edit-and-Clone]]).

> **ℹ️ Note**
> The **never counted** check only appears while the **Cycle counts** capability is on
> ([[Modular UI|Modular-UI]]). With stock-taking hidden there is no count to run, so the check
> would flag every item for something you couldn't clear — it drops out of the list and out of the
> "needs attention" tally with it.

> **ℹ️ Note**
> Nothing here is "wrong" — an item without a price is perfectly valid. The report simply shows
> where filling a gap would make your reports and schedules more complete.

## Related pages

- **[[Reports overview|Reports-Overview]]** — the full suite.
- **[[Bulk edit & clone|Bulk-Edit-and-Clone]]** — fixing many records at once.
- **[[Export & import|Export-and-Import]]** — where gaps often come from.
- **[[Cycle counts & audit day|Cycle-Counts-and-Audit-Day]]** — clearing the never-counted check.
- **[[Deduplicating items|Deduplicating-Items]]** — finding and merging duplicate records.
