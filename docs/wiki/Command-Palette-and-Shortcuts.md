# Command palette & shortcuts

Gubbins has a **command palette** for jumping anywhere and finding anything without hunting through
menus — the fast, keyboard-first way to drive the app.

**Where to find it:** the quick-search / command palette, available from anywhere in the app.

## The command palette

Open the palette and start typing to:

- **Jump to any screen** — type `>` to switch into screen-jump mode, then filter by name. It
  reaches *every* screen, not just the ones on the navigation menu: Inventory, Reports, Contacts
  and Settings, but also tucked-away views like the **Catalogue** and **Insurance schedule**
  reports and the **Manage modules** screen.
- **Search your items** — the same [[full-text search|Search-Overview]] as the inventory box,
  from wherever you are.
- **Run common actions** quickly.

It's the quickest route around Gubbins once you know your way — no reaching for the menu.

Screens that have a keyboard shortcut show it beside their name, both here and in the navigation
menu — so you pick the shortcut up naturally on your way to clicking the thing.

> **💡 Tip**
> When you want *something specific* and don't care which screen it's on, reach for the palette
> first. It searches items and destinations together, so you often get there in a few keystrokes.

## Keyboard shortcuts

A single key press can take you straight to a screen or start a job. Gubbins ships with a small set
of shortcuts and lets you change every one of them.

### The cheat sheet

Press `?` anywhere to see **every shortcut that works right now** — including the ones that depend
on which screen you're on. It's the quickest way to learn what's available, and there's a **Change
shortcuts** button on it that takes you straight to the settings.

> **💡 Tip**
> The cheat sheet only lists shortcuts that can actually do something. If a module is switched off,
> or a screen offers no search box, those rows simply aren't there.

### Going to a screen

| Shortcut | What it does |
| --- | --- |
| `F1` | Open your **Inventory** |
| `F2` | Open the **Dashboard** |
| `F3` | Open **Projects** |
| `F4` | Open **Purchase orders** |
| `G` then `R` | Open **Reports** |
| `G` then `C` | Open **Contacts** |
| `G` then `B` | Open **Bookings** |
| `G` then `U` | Open **Upcoming** |
| `G` then `A` | Open **Activity** |
| `G` then `L` | Open **Alerts** |
| `Ctrl` + `/` | Open the **command palette** |
| `Ctrl` + `,` | Open **Settings** |
| `?` | Show the **shortcut cheat sheet** |

**Two-key sequences** are written with a space: `G` then `R` means press `G`, let go, then press
`R`. They exist because there simply aren't enough comfortable single keys to give every screen
one. Pressing `G` on its own does nothing visible — it just waits a moment for the second key, and
forgets about it if you don't press one.

### Shortcuts that depend on where you are

Two shortcuts mean whatever the screen in front of you says they mean:

| Shortcut | What it does |
| --- | --- |
| `N` | **New** — adds an item on Inventory, creates a project on Projects, starts an order on Purchase orders |
| `/` | **Focus the search box** on the current screen |

On a screen that offers neither, the key is left alone and behaves normally.

### Actions you can bind

These ship **without** a key so the default set stays small, but they're in the list ready for you
to give them one: **Add item**, **Start a scan**, **New project**, **New purchase order**, **Toggle
full width** and **Toggle light/dark**.

### Changing a shortcut

**Where to find it:** Settings → **Keyboard shortcuts**, or the **Change shortcuts** button on the
cheat sheet.

Each row shows its current key. Select it, then **press the combination you want** — you don't type
it out. To record a *sequence*, press a second key straight after the first and the shortcut is
extended for you. Press `Escape` to back out without changing anything, or use the **×** beside a
row to remove its shortcut altogether. **Reset to defaults** puts the whole list back.

If you give two actions the same key, both are marked with a warning and the one **higher in the
list** wins — and the row offers to **unbind** the other action so you can settle it in one go.
Turning the **Keyboard shortcuts** switch off hands every key back to your browser.

### Ready-made schemes

Rather than rebinding a dozen rows by hand, pick a **shortcut scheme** and apply it:

- **Gubbins default** — the set described above.
- **Vim-flavoured** — `g`-prefixed sequences for every screen, `/` to search, and `i` / `o` for
  creating things.

Applying a scheme replaces every shortcut, and you can still adjust any individual row afterwards.

### Do shortcuts follow me between devices?

Your shortcuts are saved on **this device**, and they're included in a
[[backup|Backup-and-Restore]] — so restoring onto a new machine brings them with you.

> **ℹ️ Note**
> Shortcuts never fire while you're typing in a text box, or while a dialog is open — so they can't
> interrupt you mid-edit.

> **⚠️ Heads-up**
> A few keys belong to your browser and can't be reassigned: `F5` (reload), `F11` (fullscreen),
> `F12` (developer tools), and chords like `Ctrl` + `W`. Gubbins will tell you if you try one.

## Keyboard & accessibility

Gubbins is built to be driven by keyboard and assistive technology throughout:

- **Skip-to-content** link to bypass navigation.
- **Focus trapping** in dialogs, with focus restored on close.
- **Arrow-key navigation** in the [[location tree|Locations-and-Stock]] and menus.
- **Live announcements** for status changes, and accessible, associated form errors.
- **Reduced-motion** support — all decorative animation respects your system setting.

> **ℹ️ Note**
> Because the palette and shortcuts respect your enabled [[modules|Modular-UI]], you'll only be
> offered destinations and actions that are actually switched on.

## Related pages

- **[[Search overview|Search-Overview]]** — the search behind the palette.
- **[[Modular UI|Modular-UI]]** — what the palette can reach.
- **[[Appearance & theming|Appearance-and-Theming]]** — reduced-motion and other accessibility
  aids.
