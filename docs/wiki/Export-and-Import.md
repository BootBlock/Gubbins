# Export & import

Your data is yours to take anywhere. Gubbins **exports** to open formats and **imports** from
pasted text or files — so you can move data in and out without lock-in.

**Where to find it:** **Import…** beside the Add-item button, and the **Export** wizard in the
Inventory **More** menu.

## Exporting

Get your data out in whichever form suits:

- **JSON data export** — your items, contacts and loans as one structured file, for scripts and
  other tools.
- **Markdown vault** — a folder of readable Markdown files (one per item), with **full-resolution
  images** extracted alongside. Great for archiving or reading outside Gubbins.
- **Raw `.sqlite`** — the database file itself, for anyone who wants the data directly.
- **CSV** — from [[reports|Reports-Overview]], for spreadsheets.

Exports can be **scoped** — the whole inventory, a single item, a
[[project's|Projects-and-BOM]] sub-folder, or a single **location** (that location plus
every item whose home is there). Open the wizard while you're viewing a location and it
defaults to exporting that location, so **Export** starts from whatever you're looking at.

> **⚠️ Heads-up** An export is a one-way trip *out* of Gubbins — it is not a backup. The
> **JSON data export** in particular cannot be loaded back in, and Gubbins will tell you so if
> you try to restore from one. To make a file you can actually restore from, use
> [[Backup & restore|Backup-and-Restore]] instead. If you want a round-trip through a
> spreadsheet, the **Catalogue CSV** re-imports without any manual column mapping.

A [[project's bill of materials|Projects-and-BOM]] and the
[[reorder / shopping list|Reorder-and-Shopping-List]] each export on their own, straight from
where you're working — as **CSV**, **TSV**, an **Excel workbook (.xlsx)**, **JSON**, a **Markdown**
table, a printable **HTML** page, or **plain text** — for sharing, ordering or printing a parts
list. The BOM adds a grouped **EDA BOM (CSV)** for electronics tools like KiCad. The spreadsheet
formats load on demand the first time you use them, so they never slow the app down; once you've
[[installed Gubbins|Installing-Gubbins]], they're cached for offline use too.

> **ℹ️ Note** In a **CSV** or **TSV** export, a cell that begins with `=`, `+`, `-` or `@` gets a
> single leading quote (so `=A1` becomes `'=A1`). That stops a spreadsheet from treating a stored
> value as a live formula when it opens the file; the quote is hidden by the spreadsheet and the
> text reads normally. Numbers are unaffected. The Excel (`.xlsx`) export needs no such marker.

## Importing

Bringing data *in* is just as flexible. Paste text or pick a file, and Gubbins detects the format
and walks you through a review before anything is written:

- **CSV / TSV**, **JSON**, **Markdown**, or even **free-form lines** — Gubbins works out the
  columns and lets you map them.
- Pasting **free-form lines**, Gubbins recognises a bare order code or listing URL from
  several suppliers (Amazon, LCSC, DigiKey, RS Components, Farnell, Adafruit) and fills it
  in as the item's SKU automatically — handy for turning an invoice or order confirmation
  straight into items.

A [[project's bill of materials|Projects-and-BOM]] and a
[[purchase list|Purchase-Orders]] each import from where you're working, using the same format
detection — so a BOM export, a supplier basket or a typed shopping list can be brought in without
going through the item importer first.

> **ℹ️ Note**
> A chosen file is checked *before* anything is read from it, because a file picker's "All files"
> option lets anything through. Only **text** is importable: a spreadsheet workbook (`.xlsx`,
> `.ods`), a PDF, a photo or an archive is turned away with a note saying what it looks like and
> what to do instead — save the workbook as **CSV** and import that — rather than being read as
> gibberish and offered to you as rows of nonsense. Files up to **16 MB** are accepted; split
> anything larger and import the parts one at a time.
>
> If a file isn't UTF-8 — older systems and some supplier exports still use **Latin-1** —
> Gubbins reads it as Windows-1252 and *tells you it did*, so you can check the accented
> characters and symbols in the preview before importing instead of finding them mangled
> afterwards. The same checks apply wherever you import: items, a bill of materials, a purchase
> list, or a file opened straight into Gubbins from your desktop.

> **ℹ️ Note**
> A quantity of **1 is only assumed when your file gives none** — a blank cell, or no quantity
> column at all. Anything the file *does* say is taken at its word. On a bill of materials a
> quantity of **0** stays zero, which is how a line is marked "not needed for this build"; on a
> purchase list a **0** means that row isn't being bought, so it's left out. A negative quantity,
> a fractional one such as `2.5`, or a cell like `n/a` leaves its row out too. Every row left out
> is listed in the review with its row number and the value your file gave, so a quantity is never
> quietly changed on the way in.

> **⚠️ Heads-up**
> A **serialised** item is a single tracked instance, so its quantity is always 1. If a row says
> it's serialised but asks for a quantity of 5, the review flags it rather than quietly importing
> one unit — give each unit its own row.

> **ℹ️ Note**
> A [[consumable item|Tracking-Modes]] is measured by a **fill gauge**, not a count, so a row
> marked *Consumable* needs two more columns: a **Unit of measure** (`g`, `ml`, `m`) and a
> **Gross capacity** — how much a full one holds. **Tare weight** and **Net remaining** are
> optional: leave them out and the item starts full with no container weight. A consumable row
> that's missing its unit or capacity — or whose net remaining is more than a full one holds — is
> flagged in the review, with the rest of the file still importable, rather than costing you the
> whole import.
>
> The **Catalogue CSV** export carries all four, so consumables survive a spreadsheet round-trip.
> Coming back in they only apply when a row *creates* a consumable: an existing item's gauge is
> re-based from the item itself (see [[low stock & gauges|Low-Stock-and-Gauges]]), so those
> columns are ignored on a row that updates one, and on any row that isn't a consumable at all.

> **ℹ️ Note**
> Numbers copied straight out of a spreadsheet are read as they appear, so a quantity written
> `1,500` imports as one thousand five hundred. A **quantity** (or reorder point / reorder
> quantity) may carry a trailing unit the way a hand-written parts list does — `3 pcs` and
> `10 units` import as three and ten — so a count column brought in from a project's bill of
> materials reads the same in the item catalogue. A **price, weight or dimension** still has to
> be a plain number: a cell like `12kg`, `~12` or `n/a` is flagged in the review with the column
> and the value rather than being imported as a rounded-down or empty figure, because keeping its
> leading digits would silently drop the rest (`1.5 kg` is not one). A quantity with a fractional
> part is flagged the same way, rather than being quietly rounded.
>
> Every importer reads numbers by the same rule, whichever decimal convention your spreadsheet
> uses: `£1,234.56` and `1.234,56 €` both mean the same price, and prices quoted to four decimal
> places keep their precision. Where a lone separator could be read either way, a group of exactly
> three digits is treated as thousands (`1,500` is fifteen hundred) and anything else as a decimal
> (`1,50` is one and a half) — so if your figures use a comma decimal, check the review preview
> before importing.

> **💡 Tip**
> The fastest way to start a big inventory is to paste a list you already have — a spreadsheet
> column, a stocktake note — and let the importer turn it into items. Then run
> [[data hygiene|Data-Hygiene]] to fill any gaps.

> **ℹ️ Note**
> Coming from another inventory app specifically? There's a guided one-click path — see
> **[[Migrating from another tool|Migrating-from-Another-Tool]]**.

## Related pages

- **[[Migrating from another tool|Migrating-from-Another-Tool]]** — moving from another app.
- **[[Backup & restore|Backup-and-Restore]]** — full portable backups.
- **[[Bulk edit & clone|Bulk-Edit-and-Clone]]** — tidying imported data.
