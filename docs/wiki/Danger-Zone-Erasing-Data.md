# Danger zone: erasing data

The **danger zone** lets you selectively wipe parts of your data — a single kind of record, a
whole section, or every trace of Gubbins on this device — without resorting to an
all-or-nothing reset. It also holds the one action here that deletes *nothing*: **reinstall app
files**, for when Gubbins itself is misbehaving rather than your data.

**Where to find it:** **Settings → Danger zone**

## Reinstall app files

Gubbins keeps a copy of itself on your device so it works offline. Very occasionally that copy
is the problem — an update that only half applied, or a version with a bug in it — and Gubbins
keeps loading the same broken copy every time you open it.

**Reinstall app files** throws that copy away and downloads Gubbins fresh, then reloads.
**Your data is not touched**: your items, photos, settings, saved searches and sync links all
stay exactly as they are. It only replaces the app's own program files.

Reach for it when the app looks wrong, a screen won't load, or something broke right after an
update. If it doesn't help, the problem is your data rather than the app, and the erase options
below are the next step.

> **💡 Tip**
> This needs an internet connection — Gubbins has to download itself again. Offline, wait until
> you're back online before using it.

## Erasing data

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

## What your role lets you erase

With the [[Users module|Users-and-Accounts]] switched on, each entry is held to the same
[[permission|Roles-and-Permissions]] as deleting one of those records by hand: *All items* needs
**Items → Delete**, *Tags* needs **Tags → Delete**, and the **App & this device** entries need
**Settings → Change** (or **Sync → Change** / **Bridge → Change** for the sync and bridge ones).
An entry that takes other records with it needs their permission too — *All items* also needs the
permissions for the activity history, checkouts, maintenance schedules and supplier parts it
removes. **Erase everything** needs the lot, and — because it deletes the whole database rather than a list
of records — **Users and roles → Manage**, **Stock levels → Change**, **Bookings → Delete** and
**Wishlist → Delete** besides.

Entries your role doesn't allow are not listed, and if it allows none of them the **Erase data…**
button isn't shown. With the Users module off — how Gubbins ships — everything is available, as it
always has been.

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
| **Location history** | The record of what has been done to your [[locations\|Locations-and-Stock]] — renames, moves, archiving and deletions. The locations themselves, and everything stored in them, are kept. |

> **ℹ️ Note**
> **Custom field values** and **Custom field dictionary** are deliberately different. The first
> clears what's *stored* and leaves the fields available to use again; the second removes the
> fields themselves. Reach for the first unless you genuinely want the vocabulary gone.

### Projects & purchasing, and contacts

- **Projects** — every [[project|Projects-and-BOM]] with its BOM lines, budget categories and
  expense ledger. Items referenced by a BOM are kept.
- **Purchase orders** — every [[purchase order|Purchase-Orders]] and its lines. Items and
  supplier parts are kept.
- **Suppliers** — the whole [[supplier list|Suppliers]], and every supplier/order-code mapping with
  it. Purchase orders are kept — they record what was spent — but no longer name a supplier.
- **Contacts** — every [[contact|Contacts]] and their checkout/loan records. Items are kept.

### App & this device

These are local settings rather than inventory data, and none of them touch your records. Each one
takes effect straight away — the setting returns to its default as soon as you confirm, with no
need to reload:

- **App preferences** — theme, units, scanner settings and so on, back to defaults.
- **Dashboard layout** — your customised [[widget layout|Dashboard-and-Widgets]].
- **Saved searches** — the [[searches you saved|Saved-Searches-and-Favourites]] on this device.
- **Dismissed alerts** — so any still-relevant [[alerts|Alerts]] reappear, including reminders
  you've already been notified about.
- **Enabled features** — which optional features are switched on for this device, back to the
  start: the [[first-run feature chooser|Modular-UI]] appears again. No data is deleted.
- **Cloud sign-in** — signs you out of [[cloud sync|Cloud-Sync]] and discards the stored cloud
  access token. No data is deleted.
- **Bridge access token** — forgets the [[API token|Bridge-API-Tokens]] this device uses to reach
  the [[bridge|Bridge-Overview]]. Everything that needs it stops working until a token is entered
  again: pushing a snapshot, reading a [[Home Assistant scale|Counting-by-Weight]], and the
  [[webhook|Webhooks]] delivery log and test button. The bridge address is kept, the token itself
  keeps working elsewhere until you revoke it in **Users**, and nothing in your inventory is
  deleted.
- **Sync links & pending deletions** — clears the links between this device and the cloud, along
  with any unresolved [[sync conflicts|Cloud-Sync]], so the next sync starts fresh. Your inventory
  is not deleted.
- **Drafts & reminders** — the local odds and ends: export drafts, app-update reminders, an
  in-progress [[stock-take|Cycle-Counts-and-Audit-Day]] and any counts entered but not yet
  authorised, which location groups are expanded, remembered dialog and text-box sizes, and which
  one-off celebrations have already played.

> **⚠️ Heads-up**
> These three — **App preferences**, **Dashboard layout** and **Saved searches** — are the ones
> [[settings sharing|Sharing-Settings-Between-Devices]] can carry between devices, and with sharing
> switched on they do not all behave the same way:
>
> - **Dashboard layout** and **Saved searches** reset on your other devices too, when they next
>   sync — provided you are sharing that group. Turn sharing off first if you only meant to reset
>   *this* device.
> - **App preferences** stays local, because the sharing choice is itself one of the preferences it
>   resets: sharing is switched **off** here, and your other devices keep the settings they have.

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
