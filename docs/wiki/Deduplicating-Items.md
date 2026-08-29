# Deduplicating items

Two records of the same thing split its stock, its history and its loans in half. **Deduplicate
items** finds records that look like duplicates, lets you choose which one to keep, and moves
everything that referred to the others onto it.

**Where to find it:** **Settings → Inventory → Find duplicate items**.

> **ℹ️ Note**
> This never runs on its own. It only scans when you press **Scan**, and only merges the group you
> press **Merge** on. Nothing is changed just by looking.

## Catching a duplicate before you make one

You don't always need the tool. When you type a name into **Add item** — or edit one — Gubbins
checks it against the items you already have and tells you when something matches:

- **"… already exists"** — another item has the same name, ignoring capitals, spacing and accents.
- **"An item called … already exists"** — the names are merely *similar*, so it's worth a look.

Both are **advice, not a rule**. Item names don't have to be unique, and two things can legitimately
share one. The message appears when you leave the field and clears again as soon as you carry on
typing.

The [[barcode field|Items]] does the same for a GTIN another item already carries.

## Scanning for duplicates

Choose what should count as a duplicate, then press **Scan**:

| Match on | What it finds |
| --- | --- |
| **The same name** | Names that differ only by capitals, spacing or accents — `Socket screw` and `SOCKET SCREW`. |
| **The same barcode** | One barcode on two records. A short UPC-E matches the full code it stands for. |
| **The same serial number** | Two records of a single physical unit. |
| **The same part number and manufacturer** | One MPN from one maker. The maker matters: the same MPN from two vendors is two different parts. |
| **A similar name** | Names that are merely close — `Screwdriver set` and `Screwdriver sets`. |

The first four are exact and are on by default. **A similar name** is a guess, so it's off until you
ask for it, and comes with a **Loose / Balanced / Strict** setting for how alike names must be.

Results arrive as **groups**. A group is a whole cluster, not a pair: if A shares a barcode with B
and B shares a name with C, all three are shown together.

> **💡 Tip**
> Start with the exact matches. They're the duplicates you can be sure about, and clearing them
> makes the similar-name pass much easier to read.

## Merging a group

Each group is one card, listing its members with the quantity, location and how many other things
point at each of them.

1. **Choose which to keep.** Gubbins pre-selects the one holding the most stock. Pick a different
   one if you'd rather.
2. **Tick the ones to remove.** All the others are ticked to begin with; untick any that isn't
   really a duplicate.
3. **Decide about references** — leave **Move references onto the item you keep** ticked unless you
   want them left where they are.
4. Press **Merge**.

The card then reports what happened, so a group you've dealt with can't be merged twice.

## What "move references" moves

Anything **elsewhere** that names a removed item is re-pointed at the one you kept:

- [[Loans|Loans-Check-Out-and-In]] and [[bookings|Bookings]]
- [[Maintenance schedules|Maintenance-and-Servicing]] and
  [[test records|Test-and-Calibration-Records]]
- [[Project bill-of-materials lines|Projects-and-BOM]] and
  [[purchase-order lines|Purchase-Orders]]
- [[Kit membership and kit contents|Kits-and-Bundles]]
- [[Supplier parts|Supplier-Parts-and-Price-History]] and
  [[revaluations|Current-Value-and-Revaluation]]
- [[Related-item links|Tags-Attachments-and-Related-Items]] and
  [[variants|Variants-and-SKUs]]

A few of those can't survive the move, and Gubbins says so rather than doing it quietly:

- A **link the kept item already had** is dropped instead of duplicated.
- A **kit that would end up containing itself** loses the link that would have closed the loop.
- A **relation between the two merged items** disappears — an item can't be related to itself.
- A supplier part marked **preferred** or **price source** loses that mark when the kept item
  already has one. The part itself still moves.

## What stays with the removed item

The removed item keeps everything that *is* the item: its stock, photos, attachments, tags, custom
fields and [[activity log|Activity-Log]]. It is **marked as removed**, exactly as the ordinary
**Delete** action marks it — not erased.

> **⚠️ Heads-up**
> **Restore** brings a removed item back, but it does **not** move the references back. If you
> restore one, check anything that used to point at it.

Because stock stays put, a duplicate holding real stock is worth counting into the item you keep
*before* you merge — see [[locations & stock|Locations-and-Stock]].

## Limits worth knowing

- A very large inventory is scanned **oldest first**, up to a limit. When that happens Gubbins says
  how many items it examined out of how many you have, so you know there may be more.
- Only the first hundred groups are shown at once. Work through them and scan again for the rest.
- The similar-name pass compares names that share an opening or a whole word. A pair alike in
  neither is not compared, so it can miss one. The exact matches have no such limit.

## Related pages

- **[[Data hygiene|Data-Hygiene]]** — the report that flags possible duplicates alongside other gaps.
- **[[Items]]** — adding and editing the records this works on.
- **[[Bulk edit & clone|Bulk-Edit-and-Clone]]** — changing many items at once.
- **[[Export & import|Export-and-Import]]** — a common source of duplicates.
- **[[Activity log|Activity-Log]]** — where a merge is recorded, on both items.
