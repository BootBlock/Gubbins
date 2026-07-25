# Visual query builder

The **visual builder** lets you construct precise searches by clicking, without learning any
syntax — combine conditions with **AND** / **OR**, nest groups, and see results update live.

**Where to find it:** Inventory → **More** menu → **Visual search**.

![The Visual search panel: plain-English box, text-query box, and the AND/OR condition group](images/search-visual-builder.png)

## The panel

Opening **Visual search** reveals one panel with three ways in — use whichever suits you, they
all build the same query:

1. **Ask in plain English** — type a request and press Enter to fill the builder. See
   [[Natural-language search|Natural-Language-Search]].
2. **Power search** — a compact `field:value` text box. See [[Text query syntax|Text-Query-Syntax]].
3. **The graphical builder** — the AND/OR group below, built entirely by clicking.

## Building a query graphically

- **Match all / any.** The **AND** / **OR** toggle at the top of a group decides whether items
  must match *all* of its conditions or *any* of them.
- **Add condition.** Select **Add condition** to add a rule — pick a field (name, quantity, a
  [[tag|Tags-Attachments-and-Related-Items]], a [[capability|Custom-Fields-and-Capabilities]], a
  custom field…), an operator, and a value.
- **Tags.** Choose the **Tag** field and type a tag name: *contains* matches part of the name
  (`expo` finds `expo-2026`), *equals* the whole name. An item matches if any of its tags does.
- **Add group.** Select **Add group** to nest a sub-group with its own AND/OR — this is how you
  express things like *"(low quantity **OR** on order) **AND** in the garage"*.
- **Clear.** Remove everything and start over with **Clear**.

Results update as you build, and the panel shows how many items currently match.

> **💡 Tip**
> The three inputs interoperate: type a request in plain English or the text box to *populate*
> the graphical builder, then fine-tune the conditions by clicking. It's often fastest to start
> with a rough phrase and adjust.

> **ℹ️ Note**
> While the visual builder is active it supersedes the quick-search box and status chips, so
> you're always seeing exactly this query's results. Close the panel to return to quick search.

## Keeping a query

Happy with a query? **[[Save it|Saved-Searches-and-Favourites]]** to recall it later.

## Related pages

- **[[Text query syntax|Text-Query-Syntax]]** — the `field:value` language the box accepts.
- **[[Natural-language search|Natural-Language-Search]]** — build a query from a plain phrase.
- **[[Custom fields & capabilities|Custom-Fields-and-Capabilities]]** — the attributes you can
  filter and rank on.
