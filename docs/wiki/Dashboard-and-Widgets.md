# Dashboard & widgets

The **dashboard** is your landing screen — a board of **widgets** showing totals and anything
needing attention. It's fully customisable: rearrange the widgets to put what *you* care about
front and centre.

**Where to find it:** the **Dashboard** (the home screen), configured under **Settings →
Dashboard**.

![The dashboard's widget board](images/dashboard.png)

## The widget board

The dashboard is a **drag-and-drop** board. Each widget is a self-contained panel — inventory
totals, low stock, expiring soon, overdue items, maintenance due, in-transit orders, and more.
Drag them to reorder, and arrange the board to suit how you work.

Widgets are live: they read your current data, and many double as quick links straight to the
thing they summarise (select the Low stock widget to jump to what's low, for instance).

Two of them report on the app rather than your inventory: **Storage** (how much room your data
takes, and whether the browser has promised to keep it) and **Platform** (what your browser
provides, including which **storage engine** holds the database — see
[[Installing Gubbins|Installing-Gubbins]]). They're worth a glance if you're
[[diagnosing something|FAQ-and-Troubleshooting]], and easy to hide otherwise.

> **💡 Tip**
> Put the widgets you act on most at the top. If you manage a busy loan pool, lead with overdue
> and upcoming; if you run a parts store, lead with low stock and in-transit.

> **💡 Tip**
> Dragging isn't the only way to rearrange. While **Customise** is on, every card carries a small
> ▲▼◀▶ cluster that nudges it one place at a time — handy on a touchscreen — and you can move a
> selected card with the arrow keys. Each move is spoken aloud for screen-reader users ("Low stock
> moved to column 2 of 3, row 1"), so you always know where a card landed.

> **ℹ️ Note**
> A widget belonging to a [[module you've switched off|Modular-UI]] keeps its place on the board
> while it's away, so switching the module back on brings the card home. That place stays
> reserved, so a gap you can't drop into is a card waiting to return, not a fault. Nudge a
> same-sized card into it and the two simply trade places.

## Resize a card

A card doesn't have to be one cell. While **Customise** is on, each card carries a set of four
size buttons beside its ▲▼◀▶ cluster: **1×1**, **2×1** (wide), **1×2** (tall) and **2×2** (large).
Select one and the card grows to that many whole cells, so cards line up with their neighbours
without any pixel-perfect nudging. From a keyboard, hold **Shift** and press an arrow key on the
selected card — towards the arrow to grow, away from it to shrink.

**Bigger cards show more, not just bigger.** A taller card lists more rows — a 1×2 Recent activity
shows around a dozen entries instead of four, and a taller Low stock lists far more of what's
short. A wider card splits its rows into two columns, so the extra width buys twice the rows
rather than twice-as-wide ones. Inventory totals pairs its figures into two columns when widened.
The three system-status cards have a fixed set of readings and simply sit in a larger card.

A size the card can't take is shown greyed out rather than hidden — that means it would run off
the right-hand edge of the board, or overlap a neighbour. Move the card or shrink its neighbour
first, and the size becomes available. Growing a card never shoves other cards out of the way, so
the rest of your board stays exactly where you put it. Each resize is spoken aloud for
screen-reader users ("Low stock resized to a 2 by 1 card").

> **ℹ️ Note**
> Sizes apply to the wide, multi-column board. On a phone the dashboard is a single column of
> cards at their natural height, so a card you made large on a tablet won't stretch your phone's
> board. Like the rest of the arrangement, sizes are remembered per device.

> **ℹ️ Note**
> Widgets are independent, so a problem in one stays in one. If a card can't read its data or
> can't be drawn, that card alone shows a short message and every other card carries on as
> normal. The same is true of the inventory list: an item that can't be displayed becomes a
> single placeholder card or row rather than blanking the list.

## Hide cards with nothing to report

If you'd rather the dashboard stayed quiet when all is well, turn on **Hide cards with nothing to
report** under **Settings → Dashboard**. While it's on, a card is hidden whenever it has nothing
to flag — Low stock when everything's in stock, Overdue with no late loans, Soon to expire with
nothing due, Maintenance due when nothing is due, Budget alerts when every project is on track,
In transit with nothing on its way, and Project statuses with no live projects. A card reappears
the moment it has something to report, so you never miss anything.

The cards that always have something to say — Inventory totals, Recent activity, and the
system-status cards — are always shown, since they describe your data rather than flag a problem.

> **ℹ️ Note**
> **Customise** always shows every card, even the ones currently hidden, so you can still rearrange
> the board. The setting is off by default.

## Quick actions & nav tiles

The dashboard also offers quick actions (add, scan, search) and navigation tiles to your other
screens — a launchpad as well as an overview. What appears reflects the
[[modules you've enabled|Modular-UI]], and several aspects (nav-tile counts, the getting-started
panel) are configurable in **Settings → Dashboard**.

Most collection tiles carry a small count — items, active projects, open orders, contacts,
upcoming bookings. Each one counts your **whole** collection, not just what fits on the first page
of the screen behind it, so a tile with **no** count really has nothing to show.

Nav tiles rearrange the same way the widgets do: while **Customise** is on, drag a tile, nudge it
with the ▲▼◀▶ cluster or the arrow keys, and pin the ones you use most to the top of their group.

> **ℹ️ Note**
> A tile belonging to a [[module you've switched off|Modular-UI]] keeps its place too. It isn't
> shown while the module is away, but it stays behind the same tile it sat behind, so switching
> the module back on brings it home rather than leaving it at the bottom of its group. Move that
> neighbouring tile and the hidden one follows it, exactly as a visible tile below it would.

> **ℹ️ Note**
> The dashboard layout is a per-device preference — your phone and your workshop tablet can each
> have their own arrangement.

## Related pages

- **[[Modular UI|Modular-UI]]** — which widgets and tiles are available.
- **[[Alerts]]** — the attention data many widgets surface.
- **[[Appearance & theming|Appearance-and-Theming]]** — the look of the whole app.
