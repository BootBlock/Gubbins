# Items

An **item** is the record for a kind of thing you track. This page covers creating and editing
items and the fields they can hold. For the *ideas* behind items and stock, see
[[Core concepts|Core-Concepts]].

**Where to find it:** Inventory → **Add item** (or select any item to open its details).

## Creating an item

Select **Add item** in Inventory. Only a **name** is required — everything else is optional and
can be filled in now or later.

![The Add item dialog](images/add-item-dialog.png)

Common fields at creation:

- **Name** — what the item is called. The only required field.
- **Tracking** — how its quantity behaves (Bulk, Serialised, Consumable, Untracked). This is
  the one choice worth getting right up front; see [[Tracking modes|Tracking-Modes]].
- **Initial quantity** — how many you have now (Bulk items). Consumable items instead ask for a
  **unit**, a **full capacity** and a **tare** (empty weight); serialised items track units
  individually.
- **Unit cost** and **acquired date** — used for valuation, spend and the
  [[insurance schedule|Insurance-and-Estate-Schedule]].

> **💡 Tip**
> For a one-off, always-available supply (tap water, sunlight, a shared mains outlet) you can
> mark a discrete item as **unlimited supply** — it shows as ∞ with no counter.

## Editing an item

Selecting an item opens its details, organised into tabs so a simple item stays simple while a
complex one has room to grow. Depending on which [[modules|Modular-UI]] you have enabled, an
item can carry:

- **A photo** — snap or upload one; it's compressed and stored on your device.
- **A category** — group similar items (see the category manager in Inventory).
- **A location** — where it lives, and how its [[stock is split across locations|Locations-and-Stock]].
- **Notes** — free text.
- **Condition** — a structured grade (Mint / Good / Needs Repair / Out for Calibration); see
  [[Condition grading|Condition-Grading]].
- **[[Custom fields & capabilities|Custom-Fields-and-Capabilities]]** — your own fields, and
  weighted "capabilities" you can search on.
- **[[Tags, attachments & related items|Tags-Attachments-and-Related-Items]]** — labels,
  linked datasheets/files, and cross-links to items that work with this one.
- **Lifecycle** — [[warranty & depreciation|Warranty-and-Depreciation]],
  [[current value & revaluation|Current-Value-and-Revaluation]],
  [[maintenance|Maintenance-and-Servicing]], and
  [[test/calibration records|Test-and-Calibration-Records]] for serialised units.

> **ℹ️ Note**
> You'll only see tabs for capabilities you've enabled. If an item is missing something
> described here, the relevant module may be switched off on the [[Modular UI|Modular-UI]]
> screen — turning it back on restores the tab and any data it held.

## Adjusting stock

From an item's card you can nudge the quantity up or down, or open its actions to **move**,
**loan out**, **sell**, or **write off** stock. Every change is recorded — see the
[[activity log|Activity-Log]].

![An item card with its quantity stepper and actions](images/item-card.png)

## Archiving

Finished with an item but don't want to lose its history? **Archive** it instead of deleting.
Archived items drop out of the everyday lists but can be restored at any time, with all of
their data intact.

## Related pages

- **[[Tracking modes|Tracking-Modes]]** — choosing how an item is counted.
- **[[Locations & stock|Locations-and-Stock]]** — where an item's stock sits.
- **[[Bulk edit & clone|Bulk-Edit-and-Clone]]** — change or duplicate many items at once.
- **[[Inventory views|Inventory-Views]]** — card, list and table layouts.
