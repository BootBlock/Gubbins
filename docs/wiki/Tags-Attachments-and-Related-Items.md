# Tags, attachments & related items

Beyond its core fields, an item can carry **tags** for flexible grouping, **attachments** like
datasheets and photos, and **links to other items** it relates to. These live across a couple of
tabs in an item's details.

![The item detail dialog, whose tabs hold tags, media and relationships](images/item-detail.png)

## Tags

**Where to find it:** the **Classification** tab of an item's details (for items), the **Edit
location** dialog (for locations), and the **Tags** management screen (to tidy the whole set).

A **tag** is a freeform label you can stick on any item **or location** — `fragile`, `on-loan`,
`project-x`, `vintage`. Unlike a category (an item has one), a thing can have **many** tags, and
you can [[filter and search|Text-Query-Syntax]] by them. Tags are perfect for cross-cutting
groupings that don't fit a single category.

The tag box is a **drop-down you can also type into**. Click it to see the tags you already use
and pick one from the list, or just type a new name — you are never limited to what's in the
list. Press **Enter** (or a comma) to add whatever you've typed; as you type, the list narrows to
matching tags. A brand-new name creates the tag, and existing names are reused
**case-insensitively, in any language** — so `Fragile` and `fragile` are always the same tag,
and so are `Ölkanne` and `ölkanne`, or `Größe` and `GRÖSSE`. Typing a tag you already have
under different capitalisation joins the one you have rather than quietly making a second one
beside it.

The **same dictionary is shared** between items and locations: tag an item `waterproof` and a
location `waterproof`, and they use one tag — so a rename or a merge tidies both at once.

> **💡 Tip**
> Tags shine for temporary or overlapping states — tag everything going to a show `expo-2026`,
> then filter to that tag to pack, and remove it afterwards.

### Finding items by tag

Three routes, depending on how precise you need to be:

- **The tag facet** above the inventory list — tap a tag to narrow to it, the quickest option.
- **[[Power search|Text-Query-Syntax]]** — `tag:fragile` matches part of a tag's name and
  `tag=fragile` the whole name, so you can combine tags with anything else:
  `tag:expo qty<10`.
- **[[The visual builder|Visual-Query-Builder]]** — pick the **Tag** field and type a name, then
  AND/OR it with other conditions and **[[save the query|Saved-Searches-and-Favourites]]**.

An item matches if **any** of its tags does. Tag names match whichever case you type.

### Tagging locations

Open a location's **Edit** dialog to give it tags — `mobile`, `off-site`, `climate-controlled`.
The location sidebar then grows a row of **tag chips** at the top: tap one (or several) to narrow
the tree to the locations that carry them, keeping their parents in view so you never lose your
place. Tap **Clear** to show everything again.

### Tags in a spreadsheet

Tags travel with your data. The **Catalogue CSV** [[export|Export-and-Import]] writes each item's
tags into a single comma-separated `tags` cell, and the importer reads the same cell back —
creating names you don't already use and reusing ones you do, case-insensitively, exactly as
typing them here would. It's the quickest way to tag a few hundred items at once.

> **⚠️ Heads-up** That cell replaces an item's **whole** tag set, so a blank one clears its tags.
> Leave the column out of the file entirely if you want existing tags left alone.

### Showing tags on item cards

Tags can appear right on the item **cards, rows and table** so you can eyeball them without
opening an item. Turn it on from the inventory **⋯ → Card fields** picker: add **Tags** to the
shown fields (and drag it into whatever position you like). It's off by default, so cards stay
uncluttered until you ask for it.

### Managing the tag set

**Where to find it:** the **Manage tags** screen — from the inventory **⋯ (More)** menu
(**Tags**, right below **Categories**), or the command palette (`Ctrl/⌘ + K`).

This is the place to tidy the whole dictionary. Every tag is listed with how many items and
locations carry it, and you can:

- **Add** a tag up front, before you attach it to anything.
- **Rename** a tag — the new name flows to every item and location at once.
- **Merge** two tags into one (handy for folding a typo like `fragil` into `fragile`) — every
  item and location on the old tag moves to the one you keep.
- **Delete** a tag, which removes it from everything that carries it.

> **ℹ️ Note**
> Renaming to a name that already exists offers to **merge** into that tag instead — so you never
> end up with two tags that mean the same thing.

If you collect a lot of tags, the list splits into pages using the same
[[pagination control|Inventory-Views]] as the rest of the app — turn it on with **Paginate list**
(or **Settings → Inventory → Lists**), and every tag stays reachable however many you have.

#### Filtering and sorting the list

Above the list sit a **filter box** and a **sort** picker, which appear as soon as you have a tag
to look through:

- **Filter** narrows the list to tags whose name contains what you type — anywhere in the name,
  so typing `x` finds `project-x`. Press `Escape` (or the **✕**) to clear it. The filter searches
  your **whole** dictionary, not just the page on screen, so it reaches a tag however far down the
  alphabet it sits.
- **Sort** offers **Name A–Z** (the default), **Name Z–A**, **Most used first** and **Least used
  first**. "Used" counts items *and* locations together.

> **💡 Tip**
> **Least used first** brings the tags on nothing to the top — the quickest way to spot the
> one-offs and typos worth deleting or merging.

#### Taking the dictionary with you

**Export** saves the tag list as a spreadsheet or a table, with each tag's item and location
counts — a quick way to review the whole vocabulary somewhere other than the screen. It covers
every tag, not just the page in view, and follows whatever **filter** and **sort** you have
applied, so the file is the list you narrowed to, in the order you put it. See
[[Export & import|Export-and-Import]].

## Attachments & datasheets

**Where to find it:** the **Media & docs** tab of an item's details.

Attach the documents and images that belong with an item:

- **Photos** — snapped or uploaded, compressed and stored on your device. To remove one, press
  the **✕** in the corner of its thumbnail; with a mouse it appears when you hover the thumbnail,
  and on a touch screen it is always shown.
- **Datasheets and files** — either a **link** (a URL to a datasheet online) or a **local file
  pointer**. Great for keeping a part's datasheet, manual, or receipt one click away.

> **ℹ️ Note**
> Whether attachments can be external URLs, local file pointers, or both is a setting under
> **Notifications & files** — see [[Settings|Appearance-and-Theming]]. Local file pointers refer
> to files on *this* device; the [[export vault|Export-and-Import]] can bundle full-resolution
> images so they travel with a backup.

## Related items

**Where to find it:** the **Related** tab of an item's details.

Link an item to others it has a relationship with — reciprocal and always shown from both sides:

- **Works with** — two items that go together.
- **Requires** / **Required by** — a hard dependency: the first is unusable without the second.
- **Accessory for** / **Has accessory** — an add-on and its host.
- **Spare for** / **Has spare** — a replacement part and what it replaces.

### Requires — the one Gubbins acts on

The other links are descriptive: Gubbins records them and shows them, but never does anything
with them. **Requires** is different — it means "you can't use this without that", so Gubbins
watches for the gap:

- **Checking the item out** offers to lend its prerequisites at the same time, each with the
  number on hand, so a loan doesn't leave without the part that makes it work. See
  [[Loans: check out & in|Loans-Check-Out-and-In]].
- **A project's bill of materials** flags any part whose prerequisite isn't also on the list.
  See [[Projects & BOM|Projects-and-BOM]].

Both are prompts, not blocks — you can always go ahead without the prerequisite.

> **💡 Tip**
> Record the dependency on the item that *needs* it (the access point **requires** the injector),
> not the other way round. Gubbins prompts on the end that would be left unusable, so a link
> recorded backwards prompts at the wrong moment.

## Substitutions

**Where to find it:** the **Substitutions** tab of an item's details.

Mark items that are **freely interchangeable** — any of them can stand in for another in a
[[project|Projects-and-BOM]] or list. If a build calls for one and you're out, Gubbins knows a
substitute will do.

> **ℹ️ Note**
> These three groupings are distinct on purpose:
> - **Related** — items that *work together*, or that one *needs* to work (but aren't swaps).
> - **Substitutions** — items that can *replace* each other.
> - **[[Variants|Variants-and-SKUs]]** — the *same product* in different sizes/colours.

## Related pages

- **[[Custom fields & capabilities|Custom-Fields-and-Capabilities]]** — structured attributes,
  also on the Classification tab.
- **[[Variants & SKUs|Variants-and-SKUs]]** and **[[Kits & bundles|Kits-and-Bundles]]** — the
  other ways items relate.
- **[[Search overview|Search-Overview]]** — finding items by tag.
