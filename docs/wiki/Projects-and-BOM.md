# Projects & BOM

A **project** groups items into a build with a **bill of materials** (BOM), reservations and a
budget — a repair, a make, a job, a kit you're assembling. It answers *"do I have everything I
need, and can I afford it?"*

**Where to find it:** the **Projects** screen (in the menu, when the module is enabled).

![A project showing its bill of materials, budget and shopping list](images/projects.png)

## The bill of materials

A project's **BOM** lists the items it needs and how many of each. From that list, Gubbins works
out:

- What you **already have** versus what's **short**.
- An automatic **shopping list** of the missing pieces.

So starting a project immediately tells you whether you can proceed or need to buy first.

## Reservations

**Reserve** stock for a project to earmark it — the reserved quantity is set aside so it isn't
accidentally used elsewhere before you get to the build. Your available count reflects the
reservation.

## Costing & the shopping list

A project can total its cost, and toggle how it's **costed** (for example, what you'd pay to buy
the missing parts versus the value of everything in the build). The missing-parts shopping list
flows into your [[purchasing|Reorder-and-Shopping-List]].

> **💡 Tip**
> Projects are great even for one-off jobs: drop in the parts, see what's short, and let Gubbins
> build the shopping list — no need to work it out on paper.

> **ℹ️ Note**
> A **project** is a one-off build with its own BOM and budget. A reusable assembly you make
> repeatedly is better modelled as a **[[kit|Kits-and-Bundles]]** — that page has a fuller
> side-by-side comparison of the two.

## Picking the parts

When it's time to build, the **Picking** list turns the BOM into a walk-and-tick-off worksheet.
For every line it shows **where to find it** — the exact locations its stock sits in, busiest
first (for example *"3 in Garage · Shelf B, 2 in Loft bin 4"*) — drawn straight from your
[[per-location stock|Locations-and-Stock]]. Gather each part, tick it off, and a progress bar
tracks how much of the build you've collected.

A line with no matching item, or a matched item you're out of, is still listed so nothing is
forgotten — it just shows there's no shelf to walk to.

Once **every** line is ticked, the worksheet surfaces a **Finalise** step: the natural moment to
consume the gathered parts into the finished build (a new container location, a single assembled
item, or simply used up).

> **💡 Tip**
> Picking is independent of reserving. **Reserve** to earmark stock ahead of time; **pick** to
> mark it physically collected when you're actually at the shelf. A part can be reserved but not
> yet picked, or picked without ever being reserved.

## Exporting the BOM

Use **Export BOM** (beside *Import BOM*) to save the bill of materials as a file — for sharing a
parts list, ordering, or printing. Pick the form that suits:

- **CSV** or **TSV** — a spreadsheet of every line, ready for Excel, Sheets or a supplier upload.
- **Excel workbook (.xlsx)** — opens straight into Excel or Sheets with numbers kept as numbers.
- **JSON** — the lines as structured data, for a script or another tool to read.
- **Markdown table** — drops straight into notes, a README or a wiki.
- **HTML** — a tidy, standalone page that opens in your browser and **prints** cleanly.
- **Plain text** — a simple aligned table to paste anywhere.

Each line carries its part details (designator, MPN, manufacturer), the required / reserved /
received quantities, its reservation and procurement status, and the unit and line cost — so the
exported file is a complete snapshot of the build's parts.

The same menu also offers an **EDA BOM (grouped CSV)** — the layout electronics tools such as
KiCad or Altium expect. Parts that share a value, MPN and manufacturer are merged into one row,
their reference designators listed together (`R1, R2, R3`) and their quantities summed, so the file
imports cleanly into a schematic or PCB tool's BOM.

> **💡 Tip**
> Choose **HTML** when you want a printout to take to the bench or the shop — it's laid out for
> paper, **CSV/TSV** or **Excel** when a supplier or spreadsheet needs to read the numbers back, and
> **EDA BOM** when you're feeding the parts list into an electronics design tool.

## Related pages

- **[[Budgets]]** — setting and tracking a project's budget.
- **[[Kits & bundles|Kits-and-Bundles]]** — reusable assemblies.
- **[[Reorder & shopping list|Reorder-and-Shopping-List]]** — buying what a project needs.
- **[[Export & import|Export-and-Import]]** — projects get their own export sub-folders.
