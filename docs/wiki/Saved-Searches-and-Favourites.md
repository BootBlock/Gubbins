# Saved searches & favourites

A search you run often doesn't have to be rebuilt each time. Gubbins lets you **save** a query
by name and recall it in one click — and **favourite** the items you reach for most.

## Saved searches

**Where to find it:** the **bookmark** button inside the **Search items** box at the top of the
**Inventory** screen — and the same **Save search** control beneath the power-search box in the
**Visual search** panel (Inventory → **More** → **Visual search**).

Once you've built a query — by [[typing syntax|Text-Query-Syntax]], [[asking in plain
English|Natural-Language-Search]], or [[clicking it together|Visual-Query-Builder]] — select
**Save search**, give it a name, and it's kept for next time. Your saved searches then appear as
quick chips you can select to re-run instantly, or remove when you no longer need them.

### From the main search box

Select the **bookmark** button at the right-hand end of the **Search items** box and a strip of
your saved searches opens just below it. It's the same set of controls the **Visual search**
panel has, so you can save what you've just typed, bring an old search back, or forget one — all
without leaving the search box you were already using.

Recalling a search puts it wherever it belongs:

- A search made of **plain words** — *"drill bits"* — drops straight back into the **Search
  items** box and runs.
- A search that uses the [[power syntax|Text-Query-Syntax]] — `cap:voltage>3.3 qty<10` — can't be
  expressed in the quick box, so Gubbins loads it into **Visual search** and opens that panel for
  you. You can see and adjust the whole query there.

Either way only one query drives the list, so you're never looking at a confusing mix.

> **💡 Tip**
> Saved searches are perfect for recurring questions — *"anything low on stock"*, *"tools out on
> loan"*, *"parts from a particular supplier"*. Save the query once and it's one click forever
> after.

> **ℹ️ Note**
> Saved searches are stored **on your device**, alongside the rest of your data. They're personal
> to this device and don't get in anyone else's way.

## Favourites

Any item can be marked a **favourite** — a quick pin for the things you use most. A favourite
item shows a small gold star on its card.

### Seeing just your favourites

Favourited items already float to the top of any list. To narrow to *only* them, search for them
with the [[text syntax|Text-Query-Syntax]]:

```
fav:yes
```

This combines with everything else, so `fav:yes qty<10` finds *favourites that are also running
low*.

> **💡 Tip**
> Favourites and saved searches solve two different problems: **favourites** pin specific
> *items*; **saved searches** remember a *question*. Use favourites for "my go-to tools" and a
> saved search for "everything that needs reordering".

## Related pages

- **[[Search overview|Search-Overview]]** — all the ways to find things.
- **[[Inventory views|Inventory-Views]]** — how favourites and cards are displayed.
- **[[Alerts|Alerts]]** — attention filters that pair well with saved searches.
