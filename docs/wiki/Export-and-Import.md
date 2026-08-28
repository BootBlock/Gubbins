# Export & import

Your data is yours to take anywhere. Gubbins **exports** to open formats and **imports** from
pasted text or files — so you can move data in and out without lock-in.

**Where to find it:** **Import…** beside the Add-item button, and the **Export** wizard in the
Inventory **More** menu.

## Exporting

Get your data out in whichever form suits:

- **JSON data export** — your items, locations, contacts and loans as one structured file, for
  scripts and other tools. Each item names the location it lives in, and the locations themselves
  travel in the same file, so a reader can work out where everything is.
- **Items file** — the selected items as **CSV**, **TSV**, an **Excel workbook (.xlsx)**, **JSON**,
  a **Markdown** table, a printable **HTML** page or **plain text**. Pick the file format under the
  format cards; whichever you choose is remembered for next time.
- **Markdown vault** — a folder of readable Markdown files (one per item), with **full-resolution
  images** extracted alongside. Each location folder also gets a page of its own, carrying that
  location's description, icon, capacity, size and walk order. Great for archiving or reading
  outside Gubbins.

  > **ℹ️ Note** — a photo shows in the vault at whatever size *this* device holds. Full-resolution
  > photos stay on the device that took them, so on a second device, or on a photo you have let
  > [[Storage Triage|Storage-Triage]] shrink, the vault embeds the smaller preview instead.
  > Export from the device that holds the originals if you want them at full size.

  > **ℹ️ Note** — an item's note lists its [[activity|Activity-Log]] newest first, up to the most
  > recent 1000 entries. An item with a longer history than that says so above its Activity table,
  > so a shortened list is never mistaken for the whole record. Nothing is removed from Gubbins —
  > the full history stays on the item's Activity tab.
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

### Exporting a list from where you're working

Most lists export on their own, straight from the screen you're on, without going near the wizard.
Look for the **Export** button and pick a format — **CSV**, **TSV**, an **Excel workbook (.xlsx)**,
**JSON**, a **Markdown** table, a printable **HTML** page, or **plain text**:

| List | Where | What the file holds |
| --- | --- | --- |
| [[Activity\|Activity-Log]] | Activity → Items | Every change, with the item, what happened and any quantity or value movement |
| [[Location activity\|Activity-Log]] | Activity → Locations | Every change to a location — when, which place, what happened and the detail |
| [[One item's activity\|Activity-Log]] | An item → Activity | That item's own history — the same columns without the item name on every row |
| [[Alerts]] | Alert centre | The alerts you can currently see, with their urgency and due date |
| [[On loan\|Loans-Check-Out-and-In]] | Contacts & borrowing | Who has what, how many, when it went out and when it's due |
| [[Contacts]] | Contacts & borrowing | Names, contact details and how many items each person has out |
| [[Locations\|Locations-and-Stock]] | Inventory → the Locations pane | Every location with its full path, icon, description, item count, capacity, size, walk order and dead-stock setting |
| [[Bookings]] | Bookings | Which asset is reserved for whom, over which days, and its status |
| [[Purchase orders\|Purchase-Orders]] | Purchase orders | One row per order — supplier, reference, status, quantities and total |
| [[Tags\|Tags-Attachments-and-Related-Items]] | Tags | Every tag and how many items and locations use it |
| [[Bill of materials\|Projects-and-BOM]] | A project | Every BOM line, plus a grouped **EDA BOM (CSV)** for tools like KiCad |
| [[Reorder list\|Reorder-and-Shopping-List]] | Purchase orders → Reorder | What to buy, grouped by supplier |
| [[Insurance schedule\|Insurance-and-Estate-Schedule]] | Reports → Insurance schedule | Every asset with its room, condition and replacement value |

The spreadsheet formats load on demand the first time you use them, so they never slow the app
down; once you've [[installed Gubbins|Installing-Gubbins]], they're cached for offline use too.

> **ℹ️ Note** An export always contains the **whole** list, not the page of it you happen to be
> looking at — so paging through a long list first is unnecessary, and turning
> [[pagination|Inventory-Views]] on or off makes no difference to the file. Filters *do* apply: the
> Activity export covers the kinds you have selected, and the Alerts export leaves out anything
> you've snoozed or dismissed, so the file matches what's in front of you. **Locations** are the
> exception — that file always holds every location, including archived ones and anything a tag
> chip or the search box is currently hiding, because it is meant as a record of the whole place.
> If a list is ever too long to read in one go, Gubbins says so when the file saves rather than
> handing you a short file that looks complete.

> **💡 Tip** Dates and times in an exported file are written in the international
> `YYYY-MM-DD` form rather than your local format, so a file stays unambiguous whoever opens it
> and wherever they are. Prices and quantities stay plain numbers for the same reason — your
> spreadsheet formats them however you prefer. Measurements follow the same rule: a location's
> width, height and depth are written in **millimetres** whatever
> [[unit you've chosen|Language-and-Region]] on screen, and each column says so in its heading.

> **💡 Tip** The **HTML** page opens straight in a browser and follows your system's light or
> dark appearance on screen, but always prints as black text on white paper — so a printout is
> legible whichever appearance you use, without turning on "print backgrounds".

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
> A double-quote **inside** a cell is treated as ordinary text, so an inch mark reads as itself:
> `3/4" ball valve`, `1/4" drive socket` and `12" ruler` all import as the names you typed. A
> quote only marks the start of a quoted cell when it is the *first* character of that cell,
> which is what spreadsheets do too.
>
> If a file opens a quoted cell and never closes it — a stray `"` somewhere in the middle —
> everything after it would otherwise be read as one enormous cell. Gubbins says so instead of
> showing you a preview built on it, so look for the unmatched `"`. A quote you want *kept*
> inside a quoted cell is written twice: `"a 3/4"" valve"`.

> **ℹ️ Note**
> Once you've pressed import and the rows are actually being written, the dialog stays put until
> it's done — pressing Escape, clicking outside it and the ✕ all wait. It finishes on a summary:
> how many items were created, how many updated, and how many rows were skipped with the reason
> for each. That summary is the only place those reasons appear, and closing part-way through
> wouldn't have stopped the import — only hidden what it did.

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

> **ℹ️ Note**
> A row that matches an item you already have **updates** it, and that includes its **quantity**
> and its **location** — so "export the catalogue, edit the counts in a spreadsheet, import it
> back" works as a stock-take. The quantity in your file is the **count on hand**, not an amount
> to add: a row reading `250` leaves the item holding 250 whatever it held before. The change is
> recorded in the [[item's history|Activity-Log]] like any other stock movement, so you can see
> what an import moved and when. A row whose quantity already matches changes nothing and logs
> nothing, which is what re-importing an untouched export does.
>
> A **location** cell moves the item there, gathering any stock split across other places into
> it. The **Location** dropdown above the preview is different — it only says where *new* items
> go, and never moves an item you already have.
>
> Only a [[bulk item|Tracking-Modes]] has a count an import can set. A serialised, consumable or
> untracked item is flagged in the review instead, with the reason, rather than showing a number
> that would never land.
>
> The preview's **Qty** column shows what each row will do: a new item shows the figure from your
> file, and a matched one shows the new count with the current one beside it (`250 (was 200)`).

> **⚠️ Heads-up**
> A **serialised** item is a single tracked instance, so its quantity is always 1. If a row says
> it's serialised but asks for a quantity of 5, the review flags it rather than quietly importing
> one unit — give each unit its own row.

> **ℹ️ Note**
> A [[consumable item|Tracking-Modes]] is measured by a **fill gauge**, not a count, so a row
> marked *Consumable* needs two more columns: a **Unit of measure** (`g`, `ml`, `m`) and a
> **Gross capacity** — how much a full one holds. **Tare weight**, **Net remaining** and
> **Cost per unit of measure** are optional: leave them out and the item starts full, with no
> container weight and unpriced. A consumable row that's missing its unit or capacity — or whose
> net remaining is more than a full one holds — is flagged in the review, with the rest of the
> file still importable, rather than costing you the whole import.
>
> The **Catalogue CSV** export carries all five, so consumables survive a spreadsheet round-trip
> with their [[valuation|Valuation-and-Spend]] intact — *Unit cost* does not value a consumable,
> so without the cost-per-unit-of-measure column they would come back worth nothing.
> Coming back in they only apply when a row *creates* a consumable: an existing item's gauge is
> re-based from the item itself (see [[low stock & gauges|Low-Stock-and-Gauges]]), so those
> columns are ignored on a row that updates one, and on any row that isn't a consumable at all.

> **ℹ️ Note**
> A file can also carry an item's **barcode**, **serial number**, **expiry date** and **tags**,
> and the **Catalogue CSV** export writes all four — so a whole catalogue can be loaded from a
> spreadsheet and be [[scannable|Camera-Scanning]] straight away, instead of needing every
> barcode typed in afterwards.
>
> - **Barcode** — the retail barcode (GTIN / EAN / UPC) printed on the article; a column headed
>   any of those names is picked up automatically. This is what the scanner looks an item up by.
>   A short eight-digit UPC‑E is recorded as the full twelve-digit code it stands for, so an
>   imported row and a scan of the same pack agree (see [[Camera scanning|Camera-Scanning]]).
> - **Serial number** — the maker's per-unit identifier. Headings `Serial number` and `Serial no`
>   are recognised; a bare **Serial** is left alone, in case that's one of your own
>   [[custom fields|Custom-Fields-and-Capabilities]].
> - **Expiry date** — must be written as **`YYYY-MM-DD`** (`2026-08-01`), which is what the export
>   writes. Anything else — `01/08/2026`, `1 Aug 2026` — is flagged in the review rather than
>   guessed at, because `07/08/2026` means August here and July in America, and a guess would
>   quietly mis-date a perishable by a month. Headings like `Expiry`, `Best before` and `Use by`
>   all map to it.
> - **Tags** — one cell holding a **comma-separated** list (`perishable, fridge`). Names you
>   don't already use are created, and ones you do are reused whichever case you type — exactly
>   as when you type them into an item. The cell replaces the item's *whole* tag set, so a blank
>   one clears its tags; leave the column out of the file altogether to leave existing tags alone.

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
> A **weight** column is read as **grams** and **width** / **height** / **depth** as
> **millimetres**, in both directions and whatever [[units you read them in|Units-of-Measure]] —
> so a file exported on one device still means the same thing on another that's set to pounds and
> inches.
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
