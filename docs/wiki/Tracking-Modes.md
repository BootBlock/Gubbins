# Tracking modes

Not everything is counted the same way. An item's **tracking mode** decides how its quantity
behaves — and it's the one choice worth getting right when you create an item. You pick it in
the **Add item** dialog under **Tracking**.

**Where to find it:** the **Tracking** field when creating an item (Inventory → **Add item**).

## The four modes

### Bulk

For loose, interchangeable stock where you only care *how many* — screws, resistors, cable
ties, offcuts. A single number you nudge up and down.

> M3 × 10 socket screws: **250 in stock**.

### Serialised

For individually identified units — tools, instruments, devices — where each one matters. Each
unit is tracked **separately by serial number**, so you can record which specific unit you lent
out, serviced, or calibrated. Serialised items unlock per-unit
[[test & calibration records|Test-and-Calibration-Records]].

### Consumable

For things measured by how **full** they are rather than a whole count — filament spools,
solder reels, liquids, gas bottles. You set a **full capacity** and a **tare** (empty weight),
and Gubbins shows a gauge.

![A consumable item's card, showing its fill gauge](images/item-card-gauge.png)

### Untracked

For things you want to *list* but not *count* — reference material, fixtures, anything where a
quantity would be meaningless. No number at all.

## Choosing the right one

| If the item is… | Use |
| --- | --- |
| Loose and interchangeable, counted by the piece | **Bulk** |
| A unique unit you need to identify individually | **Serialised** |
| Measured by fill level, not a whole count | **Consumable** |
| Something you list but never count | **Untracked** |

> **💡 Tip**
> There's also an **unlimited supply** option for a Bulk-style item you always have on
> tap (mains power, tap water) — it shows as ∞ with no counter.

> **⚠️ Heads-up**
> Changing an item's tracking mode after the fact is limited on purpose — switching freely
> between, say, Serialised and Consumable would make its existing stock history meaningless.
> Bulk ↔ Untracked can be changed in place; for a bigger change, create the item afresh in the
> right mode.

## Related pages

- **[[Items]]** — creating and editing items.
- **[[Core concepts|Core-Concepts]]** — how tracking, stock and locations fit together.
- **[[Batches & lots|Batches-and-Lots]]** — splitting stock by delivery and expiry.
