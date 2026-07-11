# Custom fields & capabilities

Gubbins' built-in fields cover the basics, but every collection has its own attributes. **Custom
fields** and **capabilities** let you record — and search on — exactly the properties that matter
to *your* inventory.

**Where to find it:** the **Classification** tab of an item's details, once the **Custom fields &
capabilities** capability is enabled ([[Modular UI|Modular-UI]]).

## Custom fields

A **custom field** adds your own labelled value to an item — `Voltage`, `Material`, `Location
code`, `Author`, whatever your domain needs. Custom fields are typically defined per
**category**, so every item in that category shares the same set.

You can [[search|Text-Query-Syntax]] on them with the `field:` prefix:

```
field:material=steel
```

> **💡 Tip**
> Because custom fields hang off a **category**, setting a category up once gives every item in
> it the right fields automatically — no need to re-add them item by item.

## Capabilities

A **capability** is a *weighted* attribute — a property an item **has**, optionally with a
numeric value. Think `waterproof`, `voltage = 3.3`, `torque = 40`. Capabilities power Gubbins'
smartest searches:

- **Presence** — "items that are `waterproof`" (`cap:waterproof`).
- **Comparison** — "items with `voltage` over 3.3" (`cap:voltage>3.3`).
- **Best-match ranking** — when several items match, the ones whose capability is a *better* fit
  rank first, so the closest match rises to the top.

> **💡 Tip**
> Capabilities are ideal for *"find me something that can do X"* searches — the part with enough
> current rating, the tool with the right reach. Give the capability a value and let ranking
> surface the best option.

## Custom fields vs capabilities

> **ℹ️ Note**
> - A **custom field** records a fact *about* an item you want to store and display
>   (`Material = steel`).
> - A **capability** describes what an item *can do* and is built for ranked, comparative search
>   (`voltage ≥ 3.3`).
>
> Many items need only one or the other; use whichever matches how you'll look things up.

## Related pages

- **[[Search overview|Search-Overview]]** and **[[Text query syntax|Text-Query-Syntax]]** —
  searching on fields and capabilities.
- **[[Items]]** — categories and the rest of an item's data.
- **[[Tags, attachments & related items|Tags-Attachments-and-Related-Items]]** — the other
  Classification-tab tools.
