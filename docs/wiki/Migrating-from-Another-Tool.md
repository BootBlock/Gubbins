# Migrating from another tool

Already running another inventory app? Gubbins has **one-click migration** for several popular
tools — export from the old app, paste or pick the file, and Gubbins maps it in with a live
preview.

**Where to find it:** **Import…** beside the Add-item button → choose your **Import source**.

## Supported tools

Gubbins recognises each tool's export by its **column headers**, so **Auto-detect** usually just
works — or you can force a specific source:

| From | How to export |
| --- | --- |
| **Homebox** | Tools → Export (the CSV) |
| **Grocy** | Products / Stock overview → export CSV |
| **Sortly** | Export → CSV (all items) |
| **Snipe-IT** | Assets → Export → CSV |
| **InvenTree** | Part list → Export → CSV |
| **Generic** | Any spreadsheet / CSV — you map the columns yourself |

Each tool's fields are mapped to the matching Gubbins fields — name, quantity, location, price,
barcode, reorder point, and so on.

## Nothing is lost

Anything a source exports that doesn't have a clean Gubbins field — labels, tags, serial numbers,
warranty dates, and the tool's **category/group name** — is folded into each item's **notes** with
a clear *"Imported from …"* line. So no data is dropped, and no column is ever silently
mis-mapped.

Every migration runs *in front of* the normal [[import pipeline|Export-and-Import]], so you get
the same **live preview** and per-row create/update/error status **before anything is written**.

> **💡 Tip**
> Categories aren't auto-assigned (Gubbins categories carry their own [[custom
> fields|Custom-Fields-and-Capabilities]]). After importing, assign categories from the folded
> provenance note — then a [[bulk edit|Bulk-Edit-and-Clone]] makes short work of it.

> **ℹ️ Note**
> If your tool isn't listed, use **Generic (spreadsheet / CSV)** and map the columns yourself —
> the same preview and safety net apply.

## Related pages

- **[[Export & import|Export-and-Import]]** — the general import pipeline.
- **[[Bulk edit & clone|Bulk-Edit-and-Clone]]** — tidying up after a migration.
- **[[Data hygiene|Data-Hygiene]]** — finding gaps in imported data.
