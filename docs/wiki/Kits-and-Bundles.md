# Kits & bundles

A **kit** is an item defined as an assembly of *other* items — a repair kit, a starter bundle,
a product you build from components. Gubbins tracks what a kit is made of and works out **how
many you could build** from the stock you currently hold.

**Where to find it:** the **Kit** tab of an item's details, once the **Kits & bundles**
capability is enabled ([[Modular UI|Modular-UI]]).

## Defining a kit

On an item's **Kit** tab, list the component items and how many of each the kit needs:

> "Starter electronics kit" = 1 × breadboard + 10 × jumper wires + 5 × LEDs + 2 × resistor packs.

Gubbins then shows a live **"how many can I build?"** figure, calculated from the current stock
of every component — so you can see at a glance whether you can fulfil an order or need to
restock a part first.

> **💡 Tip**
> The buildable count updates as component stock changes, so a kit doubles as an early warning:
> if you can suddenly only build *one*, a component has run low. Pair it with
> [[reorder points|Reorder-and-Shopping-List]] on the components.

## Kits inside kits

A component can itself be a kit. When one is, Gubbins shows a second figure alongside the plain
buildable count: how many you could make **with sub-kits assembled on demand** — counting not
just the sub-kits already on the shelf, but the ones you could build from their own components,
all the way down. It also names the **deepest constraint**: the raw part at the bottom of the
chain that's actually holding the number back, so you restock the right thing rather than the
nearest one.

Where a part is shared by two different sub-kits, it's split between them rather than counted
twice — the figure is what you could genuinely build, not an optimistic one.

## Assembling & disassembling

Defining a kit doesn't move any stock. When you actually build one, use **Assemble** on the Kit
tab: enter how many, and Gubbins consumes the components and adds the finished kits to stock in a
single step, recorded in your [[activity log|Activity-Log]]. You can't assemble more than the
buildable count allows.

Choose a **Destination** to say where the finished kits land — any of your
[[locations|Locations-and-Stock]], or the kit's own home location by default. Components are drawn
from wherever they sit, soonest-expiry batches first.

**Disassemble** is the exact inverse — break kits back down and the components return to stock.

When a kit contains sub-kits, an **assemble sub-kits as needed** option appears. With it on, any
sub-kit you're short of is built first, in the right order, as part of the same operation — so a
multi-level assembly happens in one action instead of several.

> **⚠️ Heads-up**
> Assembling and disassembling work on items tracked as **Bulk**. An item tracked another way — a
> **Consumable** gauge, for instance — can be a *component* of a kit, but can't itself be
> assembled. See [[Tracking modes|Tracking-Modes]].

## Kits vs the other groupings

> **ℹ️ Note**
> A kit is *made of* other items. That's different from:
> - **[[Variants & SKUs|Variants-and-SKUs]]** — the same product in different sizes/colours.
> - **[[Related items|Tags-Attachments-and-Related-Items]]** — items that work with each other.
> - **[[Projects & BOM|Projects-and-BOM]]** — a one-off build with its own bill of materials and
>   budget, rather than a reusable kit definition.

### Is a kit the same as a bill of materials?

A kit's component list *is* a bill of materials — a reusable one, attached to a product you make
repeatedly, and paired with the assembly step that turns those parts into finished stock. If you'd
call something "a BOM for a product we build", that's a kit.

A **[[project|Projects-and-BOM]]** BOM is the other kind: the parts list for *one particular
build*. It's a one-off, so it carries the things a one-off needs — a budget, reservations to
earmark stock ahead of time, a shopping list for what's missing, a picking worksheet, and BOM
import/export. A kit has none of those, because a reusable definition doesn't need them.

The practical test: **would you build this again from the same list?** If yes, make it a kit. If
it's this job, this repair, this build, make it a project. The two don't currently share a parts
list — a project BOM can't be filled in from a kit definition, or vice versa.

## Kits on your other devices

Kit definitions travel with the rest of your data: they're included in
[[cloud sync|Cloud-Sync]], so a kit you build on your desktop shows up on your phone, and in the
[[backup file|Backup-and-Restore]], so restoring brings your kits back with everything else.

> **ℹ️ Note**
> If two devices add the *same* component to the *same* kit while offline, the merge keeps one
> line rather than duplicating it — whichever edit was made most recently sets the quantity.

## Related pages

- **[[Projects & BOM|Projects-and-BOM]]** — for one-off builds with budgets.
- **[[Cloud sync|Cloud-Sync]]** — keeping kits and everything else in step across devices.
- **[[Variants & SKUs|Variants-and-SKUs]]** — grouping the same product's flavours.
- **[[Reorder & shopping list|Reorder-and-Shopping-List]]** — keeping components in stock.
