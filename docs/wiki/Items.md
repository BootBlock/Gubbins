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

- **Name** — what the item is called. The only required field. Name it by *what it is*,
  specifically and consistently (`M3 × 10 socket screws`, not `screws`), so similar things sort
  together.
- **Tracking** — how its quantity behaves (Bulk, Serialised, Consumable, Untracked). This is
  the one choice worth getting right up front; see [[Tracking modes|Tracking-Modes]].
- **Initial quantity** — how many you have now (Bulk items). Consumable items instead ask for a
  **unit**, a **full capacity** and a **tare** (empty weight); serialised items track units
  individually and ask **how many** to create, one record each — see
  [[tracking modes|Tracking-Modes]].
- **Unit cost** and **acquired date** — used for valuation, spend and the
  [[insurance schedule|Insurance-and-Estate-Schedule]]. Type a plain figure like `8` and it
  tidies itself to your currency's decimal places when you move on (`8.00` for pounds, dollars
  or euros; whole numbers for yen). The tidy-up only *adds* the trailing zeros — a more precise
  figure you type, like a fraction-of-a-penny unit cost for parts bought in bulk, is kept
  exactly as entered; see [[Language & region|Language-and-Region]].

> **ℹ️ Note**
> The **maker** has its own **Manufacturer** field and part codes go in **MPN**, so you needn't
> repeat them in the name. Leading with the brand (*ASUS Q27 monitor*) is fine when it's how
> you'd recognise the item — just stay consistent. The `(i)` next to the Name field says the
> same, right where you're typing.

> **💡 Tip**
> For a one-off, always-available supply (tap water, sunlight, a shared mains outlet) you can
> mark a discrete item as **unlimited supply** — it shows as ∞ with no counter.

## Editing an item

Opening an item's **Edit details…** shows everything about it, organised into a rail of tabs so
a simple item stays simple while a complex one has room to grow.

![The item detail dialog, with its tab rail](images/item-detail.png)

The tabs you see depend on which [[modules|Modular-UI]] you have enabled:

| Tab | Holds |
| --- | --- |
| **Details** | Name, description, notes, part number (MPN), manufacturer, barcode, serial number, unit cost, category, weight and dimensions. Weight and size are typed and shown in the [[units you prefer\|Units-of-Measure]] — grams or pounds, millimetres or inches. Recording the weight of a single unit also lets you [[count a handful on a scale\|Counting-by-Weight]]. |
| **Supplier & ops** | [[Supplier parts & prices\|Supplier-Parts-and-Price-History]], reorder points, and whether this item is watched for [[dead stock\|ABC-Turnover-and-Aging]]. |
| **Lifecycle** | [[Warranty & depreciation\|Warranty-and-Depreciation]], [[current value\|Current-Value-and-Revaluation]], [[maintenance\|Maintenance-and-Servicing]], [[test records\|Test-and-Calibration-Records]], and [[variants\|Variants-and-SKUs]]. |
| **Kit** | Define the item as a [[kit of other items\|Kits-and-Bundles]]. |
| **Related** | [[Cross-links to other items\|Tags-Attachments-and-Related-Items]] (works with, accessory, spare-for). |
| **Substitutions** | [[Interchangeable stand-ins\|Tags-Attachments-and-Related-Items]] for this item. |
| **Media & docs** | Photos and linked [[datasheets/attachments\|Tags-Attachments-and-Related-Items]]. |
| **Classification** | [[Tags, capabilities and custom fields\|Custom-Fields-and-Capabilities]]. |
| **Activity** | This item's [[change history\|Activity-Log]]. |

> **ℹ️ Note**
> You'll only see tabs for capabilities you've enabled. If an item is missing something
> described here, the relevant module may be switched off on the [[Modular UI|Modular-UI]]
> screen — turning it back on restores the tab and any data it held.

The order above is the default. An item's **category** can bring its
[[custom fields|Custom-Fields-and-Capabilities]] much further forward — moving **Classification**
up to sit directly after **Details**, or giving the fields a tab of their own there under a name
the category chooses. That is why a `Movie` opens with a **Film details** tab where a `Fastener`
has none.

Each section is saved on its own — fill in what you want and press that section's **Save**. Edits
you haven't saved yet are held while you move around the rail, so you can click across to check a
photo or a supplier's part number and come back to find everything still typed in.

> **ℹ️ Note**
> If you close the dialog — with **Close**, the `Esc` key, or by clicking outside it — while a
> section still has unsaved edits, Gubbins asks first and lets you go back to finish rather than
> quietly throwing the work away.

> **💡 Tip**
> **Description** and **Notes** grow as you type, and you can drag the handle at a box's
> bottom-right corner to make it taller still. Gubbins remembers the height you drag to and
> reopens that box at your size next time; shrink it right back down to return it to the
> standard size.

Also set on an item: **Condition** — a structured grade (Mint / Good / Needs Repair / Out for
Calibration); see [[Condition grading|Condition-Grading]].

## Adjusting stock

From an item's card you can nudge the quantity up or down, or open its actions to **move**,
**loan out**, **sell**, or **write off** stock. Every change is recorded — see the
[[activity log|Activity-Log]].

![An item card with its quantity stepper and actions](images/item-card.png)

## Archiving

Finished with an item but don't want to lose its history? **Archive** it instead of deleting.
Archived items drop out of the everyday lists but can be restored at any time, with all of
their data intact.

Archiving takes one click and asks nothing first, so the message that confirms it offers an
**Undo** — press that and the item is back in your active inventory straight away. See
[[Undoing a change|Bulk-Edit-and-Clone#undoing-a-change]].

## Related pages

- **[[Tracking modes|Tracking-Modes]]** — choosing how an item is counted.
- **[[Locations & stock|Locations-and-Stock]]** — where an item's stock sits.
- **[[Counting by weight|Counting-by-Weight]]** — count small parts on a scale from their unit weight.
- **[[Units of measure|Units-of-Measure]]** — the weight and dimension units an item is shown in.
- **[[Bulk edit & clone|Bulk-Edit-and-Clone]]** — change or duplicate many items at once.
- **[[Inventory views|Inventory-Views]]** — card, list and table layouts.
- **[[How long a text field can be|Text-Field-Limits]]** — the ceiling on a name, a description or a note.
