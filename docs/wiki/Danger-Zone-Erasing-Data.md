# Danger zone: erasing data

The **danger zone** lets you selectively wipe parts of your data — a single kind of record, a
whole section, or every trace of Gubbins on this device — without resorting to an
all-or-nothing reset.

**Where to find it:** **Settings → Danger zone → Erase data…**

> **⚠️ Heads-up**
> Erasing can't be undone. Take a [[backup|Backup-and-Restore]] first — the dialog offers a
> shortcut to the backup screen before you remove anything.

## How it works

The **Erase data** dialog groups everything erasable into tabs, one per area, plus a separate
**Erase everything** tab. Tick exactly what you want gone; each entry shows roughly how many
records it will remove, and a running total sits at the foot of the dialog. Nothing happens
until you confirm.

Some entries **include** others: ticking *All items*, for example, already takes their photos,
history and checkouts with them, so those entries are shown as included rather than letting you
think they're separate jobs.

## What you can erase

### Inventory

| Entry | What goes |
| --- | --- |
| **All items** | Every item and everything attached to it — photos, history, tag links, custom field values, capabilities, checkouts, maintenance schedules, stock and supplier parts. Project BOM and purchase-order lines survive, but lose their link to the deleted items. |
| **Item photos** | Every photo, thumbnails and full-resolution files. The items stay. |
| **Activity history** | The [[activity log\|Activity-Log]] for every item. Current state is kept; only the audit trail goes. |
| **Checkout & loan records** | Every [[checkout/loan\|Loans-Check-Out-and-In]] record. Items and contacts stay. |
| **Maintenance schedules** | Every [[maintenance and calibration\|Maintenance-and-Servicing]] schedule. The items stay. |
| **Supplier parts** | Every [[supplier/order-code mapping\|Supplier-Parts-and-Price-History]]. Purchase-order lines stay but lose the link. |
| **Custom field values** | The values stored against items' [[custom fields\|Custom-Fields-and-Capabilities]]. The field definitions themselves are kept. |
| **Tags** | Every [[tag\|Tags-Attachments-and-Related-Items]], removed from all items. The items stay. |

### Organisation

| Entry | What goes |
| --- | --- |
| **Categories & schemas** | Every [[category\|Custom-Fields-and-Capabilities]] and the custom fields assigned to it, plus the matching values on items. Items stay but become uncategorised. The field dictionary and any values set on locations are kept. |
| **Custom field dictionary** | Every custom field *definition*, and with it the values stored against items **and** locations. This removes the vocabulary itself, not just the values. |
| **Empty custom locations** | Your empty custom [[locations\|Locations-and-Stock]] only. Built-in system locations, and any location still holding items or stock, are kept — empty those first if you want the location gone. |

> **ℹ️ Note**
> **Custom field values** and **Custom field dictionary** are deliberately different. The first
> clears what's *stored* and leaves the fields available to use again; the second removes the
> fields themselves. Reach for the first unless you genuinely want the vocabulary gone.

### Projects & purchasing, and contacts

- **Projects** — every [[project|Projects-and-BOM]] with its BOM lines, budget categories and
  expense ledger. Items referenced by a BOM are kept.
- **Purchase orders** — every [[purchase order|Purchase-Orders]] and its lines. Items and
  supplier parts are kept.
- **Contacts** — every [[contact|Contacts]] and their checkout/loan records. Items are kept.

### App & this device

These are local settings rather than inventory data, and none of them touch your records:

- **App preferences** — theme, units, scanner settings and so on, back to defaults.
- **Dashboard layout** — your customised [[widget layout|Dashboard-and-Widgets]].
- **Saved searches** — the [[searches you saved|Saved-Searches-and-Favourites]] on this device.
- **Dismissed alerts** — so any still-relevant [[alerts|Alerts]] reappear.
- **Cloud sign-in** — signs you out of [[cloud sync|Cloud-Sync]]. No data is deleted.
- **Sync links & pending deletions** — clears the links between this device and the cloud, so the
  next sync starts fresh. Your inventory is not deleted.
- **Drafts & reminders** — export drafts and app-update reminders.

## Erasing on your other devices too

If you use [[cloud sync|Cloud-Sync]], the confirmation step offers a choice:

- **Off (the default)** — the data is removed only from **this device**. Your cloud backup and
  other signed-in devices are left untouched.
- **On** — a deletion marker is written so the erase **propagates** to the cloud and your other
  devices on the next sync.

> **💡 Tip**
> Leave it off if you're clearing space or starting fresh on one device but want your data intact
> elsewhere. Turn it on when you genuinely want the records gone everywhere.

## Erase everything

The separate **Erase everything** tab is a factory reset: it removes every trace of Gubbins from
this device — database, photos, settings, sign-in and sync links — and reloads the app as if
newly installed. You'll be asked to confirm.

## Related pages

- **[[Backup & restore|Backup-and-Restore]]** — take one before erasing anything.
- **[[Export & import|Export-and-Import]]** — another way to keep a copy of your data.
- **[[Custom fields & capabilities|Custom-Fields-and-Capabilities]]** — what the field dictionary is.
- **[[Cloud sync|Cloud-Sync]]** — how propagation to other devices works.
- **[[Storage triage|Storage-Triage]]** — reclaiming space without deleting records outright.
- **[[How your data is stored|How-Your-Data-Is-Stored]]** — where all of this lives.
