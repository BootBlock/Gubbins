# Insurance & estate schedule

When you need a formal record of what you own and what it's worth — for an **insurer**, a
**claim**, or an **estate** — Gubbins produces a printable, room-by-room **schedule** with
replacement values and totals.

**Where to find it:** the **Reports** screen.

## What the schedule contains

The schedule is grouped **by location** (room by room) and, for each item, lists:

- The **name** and **serial number**, plus an optional **photo** thumbnail.
- **Purchase price**, **acquired date**, **warranty** and **[[condition|Condition-Grading]]**.
- A **replacement value** per item.

Each location shows a **subtotal**, and the schedule ends with a **grand total** — the headline
figure an insurer or executor needs.

### Photos are optional

**Include photos** at the top of the screen adds each item's primary photo to the schedule. It is
**off by default**, because photos are by far the largest part of a schedule: turning them on makes
the document slower to build, much larger to save, and lowers how many items can be printed in one
go (see *Printing* below).

Turn it **on** when an adjuster needs to match the document against the actual goods; leave it
**off** for a compact, fast, text-only record.

## Browsing a large schedule

The schedule is shown **a page at a time**, with the page controls at the bottom. The totals above
the document — the asset count and the grand total — always cover the **whole** schedule, not just
the page you are looking at, so the headline figure is right however much of the document is on
screen.

Where a room is split across pages, its heading says **"showing 5 of 240"** so a part-page is never
mistaken for the whole room. The room's own subtotal is always its full subtotal.

## Values reflect today's worth

Each line is valued through Gubbins' valuation logic: an item with a manual
**[[current value|Current-Value-and-Revaluation]]** is scheduled at *today's* worth, and the rest
fall back to a unit cost, then a base-currency supplier price, then purchase price less
[[depreciation|Warranty-and-Depreciation]]. So an appreciating collectible is listed at its real
replacement cost, not an out-of-date purchase figure, and an old tool priced only by what it cost
years ago is listed at its book value rather than left at nothing.

> **⚠️ Heads-up**
> The grand total is in your **base currency**, and Gubbins never converts between currencies. If
> an item's only price comes from a supplier who quotes in a different currency, it can't be added
> to the total, so it is **left out** — and a notice at the top of the schedule says how many items
> that applies to. The notice prints with the document, so an insurer or executor can see it too.
> Give such an item its own **unit cost** to bring it back into the total. See
> [[valuation & spend|Valuation-and-Spend]].

A [[gauge item|Low-Stock-and-Gauges]] — a gas cylinder, a spool, a bottle of resin — is scheduled
at **what it holds × its cost per unit of measure**, and its line is captioned with the amount
(`6m³`) in place of a quantity. Set *Cost per …* on the item; its **unit cost** prices one whole
unit and doesn't value a gauge. A gauge with contents but no such cost is **left out and named** by
a second notice at the top of the schedule, on the same principle as the currency one — a reader
who can't see an omission has no way to know the total is short.

## Printing

The schedule is **print-styled**: printing it drops the app's on-screen chrome, switches to a clean
black-on-white layout, and repeats the table header across pages. No extra software and no PDF
plugin — it uses your browser's own print, so **Print → Save as PDF** gives you a PDF.

**Use the Print / Save as PDF button** to print the schedule. Because the document is read a page at
a time, the button first loads *every* remaining page — you'll see its progress — and then prints
the complete schedule. That is what makes the printed document trustworthy: what comes out is always
the whole schedule, never the page you happened to be on.

If you print straight from your browser instead (Ctrl+P, or the browser's own menu), Gubbins prints
a **summary** — one line per room with its item count and subtotal, plus the grand total — headed
*"Summary — room subtotals only"*. It's a useful short document in its own right, and it can never
be mistaken for the full schedule.

> **ℹ️ Note**
> Whichever you print, the document says at the top which one it is. A printed schedule never shows
> only part of your inventory while looking complete — an insurer or executor has no way to tell the
> difference, so Gubbins doesn't allow it.

### Very large schedules

Printing has a size limit, because a very large schedule runs to thousands of pages. Above roughly
**20,000 items** (or **2,000** with photos on), the Print button is switched off and Gubbins suggests
**exporting** the schedule as a file instead. A file is more useful at that size anyway — it can be
searched and re-totalled, and you can print any part of it. Turning photos off raises the limit.

> **💡 Tip**
> Generate a fresh schedule after any big purchase or revaluation and keep the PDF with your
> insurance documents. It's the "one-tap schedule of loss" an insurer asks for after an incident —
> far easier to produce *before* you need it.

> **ℹ️ Note**
> Everything stays on your device — the schedule is generated locally and only leaves your machine
> if *you* save or print it. See [[Privacy & security|Privacy-and-Security]].

## Related pages

- **[[Reports overview|Reports-Overview]]** — the rest of the reporting suite.
- **[[Current value & revaluation|Current-Value-and-Revaluation]]** — the values used.
- **[[Parts catalogue|Parts-Catalogue]]** — the other printable document.
