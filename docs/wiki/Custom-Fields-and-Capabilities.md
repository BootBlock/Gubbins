# Custom fields & capabilities

Gubbins' built-in fields cover the basics, but every collection has its own attributes. **Custom
fields** and **capabilities** let you record — and search on — exactly the properties that matter
to *your* inventory.

**Where to find it:** the **Classification** tab of an item's details, once the **Custom fields &
capabilities** capability is enabled ([[Modular UI|Modular-UI]]) — though a category can
[bring its fields further forward](#bringing-a-categorys-fields-forward).

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

### One field, shared everywhere

A field is identified by its **name**. If two categories both define `Manufacturer`, they are
the same field — not two fields that happen to look alike. That's what lets a value set on a
[[location|Locations-and-Stock]] reach items in either category, and it means renaming
`Manufacturer` to `Brand` renames it everywhere at once.

Three consequences worth knowing:

- Names are matched **ignoring case**, in any language — `Manufacturer` and `MANUFACTURER` are
  one field, and so are `Größe` and `GRÖSSE`. Adding a field under a different capitalisation
  reuses the one you already have rather than quietly making a second one beside it.
- You can't define the same name twice with **different types** — if `Rating` already exists as
  a text field, adding a number field called `Rating` is refused. Pick a different name.
- Changing a field's **type** is only allowed while a single category uses it. If others share
  it, Gubbins refuses rather than silently reinterpreting the values stored under them.

Whether a field is **required**, its **default value** and its **position** stay per-category —
so `Manufacturer` can be required for Power tools and optional for Spares.

### Field types

Each custom field has a **type** that decides how you enter and how Gubbins shows its value:

- **Text** / **Long text** — a single line, or a multi-line note.
- **Number** — any number, and optionally a [[unit, an accepted range and a number of decimal
  places|#giving-a-number-a-unit-a-range-and-decimal-places]]; **Rating (1–5)** — a whole-number
  star rating.
- **Yes / No** and **On / Off** — a simple two-state toggle.
- **Date** — a calendar date.
- **Choice** — a value picked from a list of options you define.
- **URL / Link** — a web address, shown as a
  [[clickable link|#opening-a-link-or-file-field]] on the item card, the list rows and a
  location's detail panel.
- **File link** — a pointer to a file that lives *outside* Gubbins: a path on your
  computer, a network share (`\\server\share\movie.mkv`) or a `file://` link. Gubbins stores
  the **link**, not the file — so the file is never copied, never synced, and never included
  in a backup. The link travels between your devices, but it only opens on a device that can
  actually reach that path.
- **Image** — a picture stored **inside** Gubbins, ideal for a cover or a label photo. The
  image is shrunk to a compact size when you add it, then kept in your data — so unlike a
  *File link* it **does** travel with [[sync|Cloud-Sync]] and is included in every
  [[backup|Backup-and-Restore]]. It shows as a thumbnail on the item's card. (Because the
  picture isn't text, an Image field is skipped when you [[export or import a spreadsheet|Export-and-Import]] — the cell shows a small `[image]` marker instead.)

> **💡 Tip**
> Use **Image** for a cover you want to keep with the item everywhere; use **File link** to
> point at a large file (a disc rip, a hi-res scan) that's better left where it already lives.

> **⚠️ Heads-up**
> Only a picture added through the **Choose image** button is shown. If you switch an existing
> field over to **Image**, whatever was already saved against it — a web address, or plain
> text — isn't a picture, so Gubbins tells you it can't be shown and offers to replace it
> rather than trying to load it. On the item's card that field simply reads `—` until you
> choose a picture.

### Opening a link or file field

A **URL / Link** field isn't just text you can read — its value is a **link you can click**,
wherever the field is shown: on an item's card, in the dense list and table rows, and on a
[[location's own detail panel|#fields-on-a-location]]. It opens in a new tab, so you keep your
place in Gubbins. So a *Datasheet*, a *Manual* or a *Product page* field is one click away
rather than something to copy out and paste into the address bar.

A **File link** field behaves the same way *when what you pointed at is a web address* — the
type accepts one, and Gubbins notices. Point it at anything else and the value is shown with a
small file icon beside it instead, because a browser can't open a path on your disc or a network
share from a web page. The path is still there to read, copy, or paste into your file manager.

> **ℹ️ Note**
> A link only ever opens a plain `http://` or `https://` address. Anything else — a `file://`
> link, a network share, or a value that isn't an address at all — is shown as text, never as a
> link that would do nothing when clicked.

> **💡 Tip**
> A File link travels between your devices but the file itself doesn't, so a path that works on
> your desktop won't resolve on your phone. If you want a document reachable from everywhere,
> put it somewhere with a web address and use a **URL / Link** field — or attach it as a
> [[datasheet|Tags-Attachments-and-Related-Items]] on the item.

### Turning a date into a deadline

Most dates just record a fact — *Date acquired*, *Date signed* — and Gubbins leaves them alone.
But some are **deadlines**: a subscription's renewal date, an extinguisher's next inspection, the
date a resin stops being usable, a "return by" on something you've borrowed.

Tick **Use as a due date** on any **Date** field and Gubbins starts treating it like one. The
field then appears in:

- **[[Alerts]]** — as it approaches, and again (more urgently) once it has passed.
- The **[[Upcoming agenda|Upcoming-Agenda]]** — in date order, alongside servicing, warranties
  and loans.
- **[[Reminder notifications|Reminder-Notifications]]**, if you've switched those on.

Next to the tick, set **how many days' notice** you want — anything from `0` ("tell me on the
day") up to `365`. Different deadlines want different warning: a fortnight is plenty for a
subscription renewal, while a calibration certificate might want three months. Until that many
days before, the date sits quietly on the Upcoming agenda without raising an alert.

You can turn this on when you first add the field, or at any time afterwards from **Categories &
schemas** — pick the category, and the setting appears under each of its Date fields. That
matters for a field you added before, or one that came from a
[[preset|#starting-from-a-preset]] — this is how you make an existing date behave like a deadline.

> **ℹ️ Note**
> Like the field's name and type, this belongs to the **field itself**, not to one category. Tick
> it on *Renewal date* and it applies everywhere that field is used — and to values
> [[inherited from a location|#inheriting-a-value-from-a-location]] as well as those typed onto
> an item.

> **💡 Tip**
> The alert names the field, so several dated fields on one item stay tellable apart —
> *"Inspection due passed — Rack PDU"* rather than a generic "a date is due".

> **⚠️ Heads-up**
> Only **Date** fields can do this. If you change a field's type away from Date, the due-date
> setting is cleared along with it.

### Giving a number a unit, a range and decimal places

A **Number** field can carry a **unit**, an accepted **range**, and a number of **decimals**. All
three sit under the field in **Categories & schemas**, and all three are optional — a number with
none of them behaves exactly as it always has.

**Unit** is the symbol the number is measured in: `mm`, `V`, `kg`, `mAh`. Gubbins shows it beside
the value wherever the value appears — on the item's card, in the dense list, in the table, and
on a location's details panel — so you type just `5` and read `5 V`. In the editor the unit joins the field's label instead
(*Voltage (V)*), because the box itself only ever holds the number.

**Range** is the smallest and largest value allowed. You can fill in **either box on its own**:

- a **smallest** value with no largest means *at least this* — useful for a measurement that can
  never be negative;
- a **largest** value with no smallest means *at most this*;
- both together pin the value to a band, and both are inclusive;
- leave both empty to accept any number.

If you type a value outside the range, Gubbins says so as you type and won't save the item until
it's fixed — *"Voltage must be at most 24 V."* The message quotes the unit, so it reads in the
terms you set the field up in.

**Decimals** is how many decimal places the number is written to. Unlike the range, it changes how
the value *looks* as well as what's allowed:

- set **2** on a *Torque* field and `5.5` is shown as `5.50` on the item's card, the dense list, the
  table and a location's details panel;
- set **0** for **whole numbers only** — a rule a range can't express, since no smallest-and-largest
  pair rules out `2.5` while still allowing `2` and `3`;
- leave the box empty to show numbers exactly as they were typed.

Typing more decimal places than the field allows is refused the same way an out-of-range value is —
*"Shelves must be a whole number."* Typing **fewer** is fine: `5.5` on a two-decimal field is saved
and simply shown as `5.50`.

> **ℹ️ Note**
> Like the field's name and type — and like the due-date setting above — a unit, a range and the
> decimals belong to the **field itself**, not to one category. Set them on *Voltage* and they
> apply everywhere that field is used, including values
> [[inherited from a location|#inheriting-a-value-from-a-location]].

> **💡 Tip**
> Decimals only change how the value is *displayed* — the number you typed is what's stored. So you
> can raise or lower the setting later and every existing value is rewritten to match, rather than
> leaving a mixture of old and new. The box you type the value into keeps it as you typed it, and so
> do exports and searches.

> **💡 Tip**
> Use the **Unit** setting rather than putting the unit in the field's *name* or its
> [[note|#adding-a-field-note]]. A field called *Voltage* with a unit of `V` shows the same
> *Voltage (V)* on screen, but the value keeps its unit on every card and list too — and the
> range messages can quote it.

> **⚠️ Heads-up**
> Only **Number** fields can carry a unit, a range or a decimals setting. If you change a field's
> type away from Number, all three are cleared along with it. A range can't be set back-to-front
> either: a smallest value above the largest would accept nothing at all, so Gubbins refuses it.

### Marking a field as a key field

Some fields matter more than the others beside them. A watch's *Movement* and *Reference* are what
you look for; its *Bracelet* and *Anti-magnetic* are detail. Tick **Key field** under a field in
**Categories & schemas** and it moves to the **front** of the list everywhere it appears — on every
item that has it, on a location that holds a value for it, and in the category's own field list.

Tick it on as many fields as you like. Key fields lead, in their usual order among themselves;
everything else follows, also in its usual order. Nothing else changes: the field is not renamed,
re-typed or moved to another tab, and it still saves, syncs, exports and searches exactly as before.

> **ℹ️ Note**
> Like the field's name and type — and like the due-date, unit, range and decimals settings above —
> this belongs to the **field itself**, not to one category. Mark *Serial number* as a key field and it
> leads in every category that uses it, and on values
> [[inherited from a location|#inheriting-a-value-from-a-location]]. That is also what makes it work
> on a location, whose fields have no order of their own to arrange.

> **💡 Tip**
> This setting and [**Where the custom fields go**](#bringing-a-categorys-fields-forward) answer two
> different questions, and work together rather than against each other. That one decides *which tab*
> the whole set of fields lives in; this one decides *which field leads* once you are looking at
> them. Give a category's fields their own tab **and** mark the one that matters most, and you get
> both.

### Fields on a location

A location can hold field values of its own, exactly as an item can — a shelf's load rating, a
room's humidity, an access note. Open a location's **Edit** dialog and find **Fields**, then add a
field and give it a value.

![The Fields panel in a location's Edit dialog: a Storage conditions field set to "Dry, unheated", with "Offer to items here" ticked](images/location-inheritable-fields.png)

Whatever a location holds shows in the panel above the item list whenever that location is
selected, and the location tree's search box matches it — see
[[Locations & stock|Locations-and-Stock#the-details-panel]].

### Inheriting a value from a location

Instead of typing the same value onto every item in a drawer, you can set it **once on the
location** and let the items take it: tick **Offer to items here** on that value's row. Any item
in that location — or in any location nested inside it — can then pick up that value.

On the item, the field grows a small chooser above it:

- **Inherit — *value* (from *location*)** — take the location's value.
- **Set a value for this item** — enter your own, exactly as before.

![An item's Custom fields section, with the Storage conditions field set to inherit "Dry, unheated" from the Garage](images/item-inherited-field.png)

Inheriting is **opt-in per item and per field**: nothing changes on existing items until you
choose it. The chooser only appears when a location above the item actually offers that field.

> **💡 Tip**
> Inherited values are *live*. Change the value on the location and every item inheriting it
> follows immediately — no re-editing. Move an item to a different location and it picks up
> that location's value instead.

When locations are nested, the **nearest one wins**: if `Workshop` offers `Manufacturer =
Ryobi` and `Workshop → Cabinet A` offers `Makita`, an item in Cabinet A inherits Makita.

Inherited values behave like any other for [[search|Text-Query-Syntax]] — `field:manufacturer=ryobi`
finds items that inherit Ryobi just as it finds items that store it.

> **ℹ️ Note**
> Ticking **Offer to items here** is deliberately separate from setting the value. A location
> can record a detail about *itself* — a shelf's load rating, a room's humidity — without every
> item inside quietly adopting it. Either way the value stays visible on the location, in the
> panel above its item list.

If a location stops offering a field (you untick the box, clear the value, or move the item
elsewhere), items that were inheriting fall back to the category default. Your choice to inherit
is remembered, so restoring the value on the location restores the inheritance too.

### Reading fields from other systems

If you run the [[bridge|Bridge-Overview]], custom-field values can be read by whatever you
connect to it — inherited values included, resolved exactly as they appear in the app. That makes
a custom field a good place to record something another system needs to know: which light sits
above a shelf, which printer serves a room, a supplier's reference for a part.

There are two different routes, and they behave differently — worth knowing which is which:

- **Asked for.** A system reading the bridge directly gets field values only when it explicitly
  requests them, so ordinary requests stay small and nothing is volunteered.
- **Published.** If you've switched on [[MQTT publishing|Webhooks-MQTT-and-iCal]], each
  **location's** fields are sent to your broker automatically, as attributes on that location's
  [[Home Assistant entity|Home-Assistant-Integration]] — that's what lets an automation read them
  without asking. Item fields are never published this way.

> **ℹ️ Note**
> This is read-only — nothing connecting to the bridge can change a field's value. Editing stays
> in the app.

> **⚠️ Heads-up**
> Because location fields are *published* rather than asked for, everything you record on a
> location reaches your broker once MQTT publishing is on — you can't currently publish some of a
> location's fields and hold others back. It's your own broker, so this is usually exactly what you
> want; just think twice before recording something like a door code or a valuation on a
> **location** rather than on an item.

### Adding a field note

When you define a custom field you can give it an optional **Description** — a short note about
what the field is for. If you fill it in, an **(i)** info badge appears next to that field on
every item in the category; hovering or focusing it shows your note. It's the ideal place for a
reminder such as *where to read the value from*, or a link to a reference. The note supports
Markdown, and leaving it blank simply hides the badge.

> **💡 Tip**
> For a number's unit of measure, use the [[**Unit** setting|#giving-a-number-a-unit-a-range-and-decimal-places]]
> rather than this note — that way the unit is shown beside the value itself, not tucked behind a
> badge.

### Starting from a preset

Rather than adding fields one at a time, the category manager's **Add from a preset** picker
creates a ready-made category with a curated set of custom fields already attached — covering
maker and hobbyist staples like `Battery`, `Cable`, `Electronic component`, `Fastener`,
`3D Filament`, `Fabric`, `Paint`, `Adhesive` and `Model kit`, plus a large library of collector
staples spanning cards and coins (`Trading card`, `Baseball cards`, `Magic: The Gathering cards`,
`Coin`, `Banknote`), media (`Movie`, `Book`, `Vinyl record`, `DVDs`, `Blu-rays`, `Video games (physical)`,
`Vintage movie posters`), timepieces and jewellery (`Luxury watches`, `Mechanical wrist watches`,
`Handbags`, `Gold & silver bullion`), toys and figures (`Action figures`, `Funko Pop figures`,
`LEGO sets`, `Die-cast model cars`, `Warhammer & tabletop gaming miniatures`), and antiques and
curios (`Antique furniture`, `Porcelain & fine ceramics`, `Vintage cameras`, `Fountain pens`,
`Stamps`, `Postcards`), and storage and containers (`Tool bag`, `First aid kit`, `Storage tote`,
`Gridfinity bin`) — among many others. Pick one, then rename, extend or trim its fields to
match your own inventory.

The picker is organised for browsing: sections down the left-hand side — **Workshop**,
**Electronics**, **Household**, **Storage & containers**, **Crafts & hobbies**, **Media** and
**Collectibles**, plus **All presets** for the whole library at once — and, on the right, the presets of the chosen
section. Each preset shows its name, a one-line description and a sample of the custom fields
it creates, so you can see what you're getting before you add it.

A **search box** above the sections filters the library as you type, matching preset names,
descriptions and field names alike — so `isbn` finds the `Book` preset and `expiry` finds
`Food` and `Adhesive`. While you're searching, each section shows how many of its presets
match. Press the **✕** button — or **Escape** while typing in the search box — to clear the
search; pressing **Escape** anywhere else (or with the search box empty) closes the picker.

> **ℹ️ Note**
> A preset whose category already exists is marked **Added** and can't be imported twice, so
> there's no risk of duplicates.

### Bringing a category's fields forward

Custom fields normally live in the **Classification** tab, near the end of an item's tabs. That
is the right place for a bolt, whose custom fields are a footnote to its built-in ones — and the
wrong place for a film, whose Format, Director and Year are close to the whole point of the
record.

So a **category** can say how prominent its own fields should be. Open **Categories & schemas**,
pick a category, and find **Where the custom fields go**. There are three choices:

- **Leave them where they are** — the default, and what every category has always done. The
  fields stay inside **Classification**, alongside tags and capabilities.
- **Move Classification up** — the whole **Classification** tab moves to sit directly after
  **Details**, bringing its tags and capabilities with it. Nothing is restructured; the fields
  are simply much closer to hand.
- **Give them a tab of their own** — the custom fields break out into their **own tab**, directly
  after **Details**, under a name you choose. Tags and capabilities stay behind in
  Classification.

Choosing the third option reveals a **Tab name** box. Use it to name what the fields collectively
*are* — *Film details*, *Pressing*, *Provenance* — rather than repeating "custom fields". Leave
it blank and the tab is simply called **Custom fields**. The name you type is kept even if you
switch back to another option later, so changing your mind never loses it.

> **ℹ️ Note**
> This only moves things. No field is added, removed, renamed or re-typed, nothing stops syncing,
> and searching with `field:` works exactly the same wherever the fields sit.

Several of the built-in presets come with a choice already made: `Movie`, `Book`,
`Vinyl record`, `DVDs`, `Blu-rays`, `Video games (physical)` and `Vintage movie posters` each
give their fields a tab of their own with a fitting name. Everything else starts at the default —
a preset is only a starting point, so change it to suit.

> **⚠️ Heads-up**
> If a category also hides its custom fields (below), the two settings contradict each other, so
> Gubbins says so and offers to show the fields again. Until you do, items with nothing recorded
> keep the ordinary tab order — but an item that *does* have values still shows them, with the
> usual note explaining why, so nothing is ever buried. The same goes for turning the **Custom
> fields & capabilities** capability off under [[Modules|Modular-UI]]: the tabs then simply stay
> where they always were.

### Hiding the sections a category doesn't need

Gubbins tracks a lot about an item — maintenance schedules, batches, expiry dates, variants,
kit parts — and most of it makes no sense for *some* of what you own. A film has nothing to
service and no best-before date; a coin doesn't arrive in lots.

You could switch those capabilities off entirely under [[Modular UI|Modular-UI]], but that
hides them **everywhere** — including on the power tools that genuinely need them. So a
**category** can say what its own items don't have.

Open **Categories & schemas**, pick a category, and find **Sections these items don't need**.
Tick anything that doesn't apply, and it disappears from every item in that category —
on the item's details *and* on the form for adding a new one.

> **ℹ️ Note**
> This only changes what you **see**. Nothing is deleted, nothing stops syncing, and reminders
> carry on as normal. Untick the box and everything is exactly where you left it.

**Nothing with something in it is ever hidden.** If an item already has, say, a maintenance
schedule recorded — perhaps you added it before hiding the section, or it arrived from another
device — that section is shown anyway, with a short note explaining why it's there. You can't
lose track of information this way.

The built-in presets come with sensible choices already made: `Movie`, `Vinyl record`, `Coin`
and `Postcard` all hide maintenance, expiry and batch tracking. Anything that genuinely gets
serviced — watches, cameras, instruments, arcade machines — keeps everything. As always, a
preset is only a starting point; change it to suit.

> **⚠️ Heads-up**
> A category can only hide **more**, never bring something back. If a capability is switched off
> under [[Modules|Modular-UI]], it stays off everywhere, and unticking it here won't return it —
> switch the module back on instead.

> **💡 Tip**
> If a category is also set to give every new item a **maintenance schedule** (below) *and* you
> hide the Maintenance section, Gubbins points out the contradiction and offers to stop adding
> the schedule — otherwise it would create one on every item and then hide it.

### Giving a category a glyph

A category can carry an optional **glyph** — a single emoji such as 🔋 for batteries, 📖 for
books or 🛠️ for tools. Open **Categories & schemas**, pick the category, and use the **Glyph**
field to choose one; the built-in presets each come with a fitting glyph already set.

When a category has a glyph, every item in it shows that glyph as a large, faint **greyscale
watermark** in the bottom-right corner of its card in the [[Visual view|Inventory-Views]] — a
quick at-a-glance cue for what kind of thing each card is. The watermark is always drawn in
greyscale at a low opacity, so it reads as a background texture rather than competing with the
item's details.

Choosing a glyph opens a **glyph browser**: a list of groups down the left (Smileys, People,
Animals & nature, Food & drink, Objects, Symbols and more) with a **search box** above them that
filters every glyph as you type — search by name or by what it means (`car`, `screw`, `battery`).
The grid on the right shows the chosen group, or your search matches. Pick a glyph with the
mouse, or move through the grid with the **arrow keys** and press **Enter**; press **Escape** to
clear the search, or again to close. The browser can be resized by dragging its corner, and it
remembers the size you set.

> **💡 Tip**
> Prefer a cleaner grid? Turn all category watermarks off in one place under **Settings → Item
> cards → Category watermarks** — that hides every watermark without clearing any category's
> glyph, so you can switch them back on any time.

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
