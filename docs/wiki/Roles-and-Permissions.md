# Roles & permissions

A **role** is a named set of permissions you hand to one or more people — *"Stocker"*, *"Viewer"*,
*"Workshop lead"*. Rather than ticking boxes for every person, you describe the job once and assign
it.

**Where to find it:** the **Roles** section at the bottom of the **Users** screen (part of the
[[Users module|Modular-UI]]).

![The role editor: a grid of permissions with a row per area of Gubbins and a column per action](images/users-role-editor.png)

## The roles Gubbins ships with

Eight roles come ready to use. You can retune what any of them allows, but they can't be deleted —
people are assigned to them.

The first four describe **how much** of Gubbins someone gets:

| Role | What it allows |
| --- | --- |
| **Administrator** | Everything, including managing users and roles |
| **Manager** | Everything across inventory, projects and settings, but can't manage users or switch modules off |
| **Stocker** | Add and edit items, move stock, run counts and print labels. No deleting, and no activity history, projects, contacts, suppliers, purchase orders, bookings, user accounts, sync or bridge setup |
| **Viewer** | Look at inventory, projects, contacts, suppliers, purchase orders, bookings and reports; change nothing. No activity history, no export, no user accounts, sync or bridge setup |

The other four describe **which job** someone does. They overlap in what they can see and differ
sharply in what they can change, so pick by the post rather than by seniority:

| Role | What it allows |
| --- | --- |
| **Auditor** | Everything Viewer sees, plus the activity history and the ability to export it. Changes nothing, and can't prune the history it inspects |
| **Purchaser** | Owns suppliers, purchase orders and the wishlist outright, and can receive a delivery against an order. Edits items but never deletes one |
| **Technician** | Owns maintenance, lends and returns equipment, consumes stock on a job and prints labels. The catalogue stays read-only |
| **Loans desk** | Lends and returns equipment, owns bookings including cancelling one raised in error, and keeps borrower contacts. The catalogue stays read-only |

> **ℹ️ Note**
> None of the four job roles holds **Users and roles**, **Modules**, **Settings**, **Backups**,
> **Sync** or **Bridge**. Doing work in Gubbins and administering the device it runs on are
> separate jobs. If someone needs both, give them Manager or a role of your own.

Each shipped role carries an icon — a shield for Administrator, an eye for Viewer, a spanner for
Technician — so the list reads at a glance rather than by name alone.

Add your own with **Add role** whenever none of these quite fits. Role names are matched **ignoring
case, in any language**, so `Workshop Lead` and `WORKSHOP LEAD` are one role rather than two that
look alike. A role you create can have an **icon** of its own: pick one from the icon chooser, or
leave it blank and Gubbins uses the default role glyph. You can change or clear the icon on a
shipped role in the same way.

> **ℹ️ Note**
> These are shown in your [[interface language|Language-and-Region]]. Rename one — or rewrite
> its description — and your own wording is what Gubbins shows from then on, whatever language you
> switch to.

## How permissions are described

Permissions are a grid: a **row for each area** of Gubbins and **three columns** — View, Change and
Delete.

- **Areas** are the things you work with — items, stock levels, locations, categories, tags,
  projects, contacts, suppliers, purchase orders, bookings, loans, maintenance, wishlist, reports —
  plus those that cut across the app: activity history, import, export, labels and printing,
  settings, modules, storage, users and roles, backups, [[sync|Cloud-Sync]] and the
  [[bridge|Bridge-Overview]].
- **Every box sits in the column that says what it does.** An area with nothing in a column leaves
  that cell empty, so reading straight down a column always means the same thing. **Stock levels**
  has no Delete — stock is written down or written off, never deleted. **Activity history** has
  View and Delete but no Change, because the ledger is a record of what happened and isn't edited.
- **A few boxes are narrower than their column, and say so underneath.** **Users and roles** shows
  **Manage** in the Change column, because anyone who can edit an account could grant themselves
  anything anyway. **Import** and **Export** show **Run**, and **Labels and printing** shows
  **Print** — "change" describes none of the three.

Every row and every column carries an **ℹ️** badge. Hover or focus it for the full explanation of
exactly what that permission gates, including the areas it reaches that you might not expect.

> **ℹ️ Note**
> **Change** covers an area's own details *and* the things attached to it — an item's attachments,
> photos, capabilities and BOM lines are all part of changing the item. **Delete** means deleting
> the item itself, and is never granted by Change.

### The three that gate a capability rather than a record

Three areas are worth calling out, because withholding them stops something people often assume
is covered by an area's own View or Change:

- **Import → Run** is needed *in addition to* the Change permission for whatever is being
  imported. Editing one record and merging a supplier's catalogue into the whole inventory are
  different acts with different consequences.
- **Export → Run** covers the export wizard, the vault archive, and the CSV and spreadsheet
  buttons throughout the app. Withholding it hides nothing on screen — someone with **Items →
  View** still reads every item — but it stops them taking the lot away in one file.
- **Modules → Change** decides who may switch parts of Gubbins on and off. It is the permission
  that protects every other one, because switching the Users module off takes the sign-in gate
  down with it. The built-in **Manager** role is deliberately given View without Change here.

## What **View** actually does

Most areas have a screen of their own, and for those, **View** decides whether it opens. Take
**View** away and the screen disappears from the navigation menu, from the Dashboard's tile grid,
from the keyboard shortcuts and from the [[command palette|Command-Palette-and-Shortcuts]] — and
typing the address by hand lands on a short "your role doesn't allow this" page instead. Any
[[dashboard|Dashboard-and-Widgets]] card summarising that area drops off the board too, so nothing
quietly reports what the screen won't show.

**View** does more than open a screen, and for some areas it is all it does. Where each one bites:

- **Activity history → View** covers the [[activity log|Activity-Log]] screen *and* the per-item
  and per-location history tabs, which are the same record seen from a different angle.
- **Backups → View** allows creating a [[backup|Backup-and-Restore]], because a backup file is a
  copy of the whole database rather than a page to look at. Backup & restore shares the
  [[Sync|Cloud-Sync]] screen, so that screen opens for a role granted backups even without
  **Sync → View** — and shows only the backup half to it.
- **Loans → View** and **Maintenance → View** govern the [[Upcoming|Upcoming-Agenda]] and
  [[Alerts|Alerts]] entries drawn from them, since neither has a screen of its own.
- **Settings** is the exception that stays open to everyone: it holds this device's own
  preferences — [[appearance|Appearance-and-Theming]], [[language|Language-and-Region]] — rather
  than your inventory, so **Settings → Change** is the permission that bites there, not View.
  Its **Data & storage** tab is the one part held back, under **Storage → View**.
- **Storage → View** opens that tab and the storage figures on [[About|About-and-Diagnostics]].
- **Modules → View** opens the [[Modules|Modular-UI]] screen. Grant it alongside **Change** —
  Change on its own doesn't open the screen, so a role holding only Change can edit nothing.

Three areas have no View at all, because they are things you *do* rather than places you go:
**Import**, **Export** and **Labels and printing** each have a single box, and withholding it
removes the buttons that start them.

> **ℹ️ Note**
> Four areas — **Stock levels**, **Locations**, **Categories** and **Wishlist** — currently show a
> **View** box the app itself never checks. Their records are read wherever an item shows them,
> and Gubbins does not hide an item's own page field by field. **Locations → View** and
> **Categories → View** do take effect for the [[bridge|Bridge-Overview]], which serves those two
> as endpoints of their own; **Stock levels → View** and **Wishlist → View** take effect nowhere
> yet. Their **Change** boxes, and the **Delete** boxes they have, work as described.

Those two aggregating screens, Upcoming and Alerts, stay available to everyone and simply leave out
the entries a role can't view.

Withholding **View** is not the same as hiding individual records:

- A screen someone *can* open shows **everything on it**. There is no per-item or per-location
  visibility — Gubbins has no concept of "this item is hidden from Sam".
- Some information travels between areas by design. An item's own page names the project it's
  committed to and the supplier it came from, whether or not that person can open the Projects or
  Suppliers screen.

> **⚠️ Heads-up**
> If a piece of information genuinely must not be seen by someone, don't rely on **View** to keep it
> out of sight — keep it out of that vault. Permissions decide which screens and actions a person
> gets, not which rows exist.

## What the destructive actions are held to

Permissions are not only about the buttons on an item. The actions that can remove or overwrite
everything at once are held to the same role:

- The [[danger zone|Danger-Zone-Erasing-Data]] entries are held to the **Delete** permission for
  the area each one erases — *All items* to **Items → Delete**, *Tags* to **Tags → Delete**, and so
  on. Areas with no Delete action use **Change** instead, because that is the strongest permission
  they have. The **App & this device** entries are held to **Settings → Change**, except those with
  an area of their own: sync links and cloud sign-in need **Sync → Change**, and the bridge token
  needs **Bridge → Change**. *Enabled features* needs **Modules → Change** as well, because
  resetting it switches the Users module off and takes the sign-in gate with it — the danger zone
  must not be a way around the permission that guards the rest.
- An entry that takes other records with it needs *their* permission too. *All items* removes each
  item's activity history, loans, maintenance schedules and supplier parts, so it needs
  **Activity history → Delete**, **Loans → Delete**, **Maintenance → Delete** and **Suppliers →
  Delete** as well as **Items → Delete** — the same permissions the entries for those records ask
  for on their own.
- **Erase everything** — the factory reset — needs *all* of those at once, plus four the entries
  never ask for on their own: **Users and roles → Manage**, **Stock levels → Change**, **Bookings →
  Delete** and **Wishlist → Delete**. It deletes the whole database rather than a list of records,
  so it reaches accounts, roles, stock levels, bookings and the wishlist as well.
- **Exporting** needs **Export → Run**, wherever the button appears — the export wizard, the vault
  archive and the CSV and spreadsheet buttons on Activity, Alerts, Bookings, Contacts and the
  location lists. Someone refused it can still read every screen their role opens.
- Creating a [[backup|Backup-and-Restore]] needs **Backups → View**: a backup file contains the
  whole database. Restoring one needs **Backups → Change**. **Replace** needs both, because it
  saves a restore point of your current data first, and that restore point is itself a backup.

Entries and buttons someone's role doesn't allow aren't shown to them at all, so nothing is offered
that would only be refused.

> **⚠️ Heads-up**
> **Backups → Change** is a powerful permission. A restore rewrites every synced record from the
> file, and accounts and roles are synced records — so someone who can restore can, with a
> hand-edited backup, change what any account is allowed to do. Grant it on that understanding.

> **ℹ️ Note**
> Someone who is refused **Items → Delete** on a single item is refused *All items* in the danger
> zone too. **Change** is not enough for either — which is why the built-in **Stocker** role, which
> can edit items but not delete them, cannot erase the catalogue.

> **⚠️ Heads-up**
> The **rescue screen** is deliberately outside all of this. Its whole purpose is to hand your data
> back when the app is broken, so its backup, restore and reset actions stay available to whoever
> holds the device, whatever their role — and it appears not only when Gubbins can't start, but
> also whenever a screen fails badly enough to fall back to it. Treat it as an escape hatch that
> anyone using the device can reach. See [[Privacy & security|Privacy-and-Security]].

## Allowing a whole area, or everything

Two shortcuts save a lot of ticking:

- **Everything under &lt;area&gt;** grants every action for that row — *including* any action added
  to that area in a future update.
- **Allow everything** grants the lot, across the whole app, again including anything a future
  version adds. This is how the built-in **Administrator** role is defined, so "Administrator" keeps
  meaning *everything* as Gubbins grows.

> **⚠️ Heads-up**
> Ticking or unticking *any* individual box in a whole-area row **turns that shortcut off**. The row
> keeps exactly the actions shown at that moment, and stops picking up actions added in future
> updates. That's deliberate — you asked for a specific set — but it's easy to do by accident when
> you only meant to remove one action.

> **💡 Tip**
> Use the whole-area and everything shortcuts for roles you *want* to grow with the app, and tick
> individual boxes for restricted roles. That way a new capability reaches your admins automatically
> and never quietly reaches a Viewer.

## Assigning and removing roles

A role is set on the account itself — see [[Users & accounts|Users-and-Accounts]]. Someone with **no
role** can sign in but can't do anything, which is a useful holding state for a new starter.

Deleting a role doesn't delete anyone. People holding it keep their accounts and simply have no
permissions until you give them another one.

### When a change reaches another device

A change to someone's role — or disabling or deleting their account — applies on the device you
made it on straight away. Another device picks it up on its next [[sync|Cloud-Sync]], and the new
permissions apply there as soon as that sync finishes. Nobody has to reload or sign in again for it
to take. If the account was disabled or deleted, that device is returned to the
[[sign-in screen|Signing-In]] at the same moment.

> **ℹ️ Note**
> Sync is how the change travels between devices, so a device that hasn't synced since you made
> it is still working to the permissions it last knew about. Restoring a
> [[backup|Backup-and-Restore]] applies the accounts and roles in the file the same way.

A role also governs what an outside tool can do. An [[API token|Bridge-API-Tokens]] minted against
an account is held to that account's role, so the same limits follow it out of the app. The bridge
checks the permission on **every request**, against the data rather than a screen: a role without
**Activity history → View** is refused the activity feed itself, and one without **Items → View**
is refused the item endpoints, the search and the OData service alike.

> **⚠️ Heads-up**
> Permissions decide what Gubbins *lets someone do in the app*. They are not a lock on the data
> itself — anyone with access to this device's files can still read everything. Roles keep honest
> people out of each other's way on a shared device; they are not a security barrier against
> whoever holds it. See [[Privacy & security|Privacy-and-Security]].

> **ℹ️ Note**
> Switching the Users module off takes the sign-in gate down with it, so that is held to
> **Modules → Change** — not only on the [[Modules|Modular-UI]] screen, but on the "this module
> is hidden" page and the first-run chooser, which write the same list. Someone without it keeps
> **Continue anyway** on the hidden-module page, so they are never stuck.
>
> The way back in if *nobody* can sign in is unaffected: the **Can't sign in?** control on the
> [[sign-in screen|Signing-In]] switches the module off from outside the gate, where no role
> applies.

## If a role mentions permissions Gubbins doesn't recognise

If your devices are on different versions, a role edited on a newer one may hold permissions this
version hasn't heard of. Gubbins says so, keeps them exactly as they are, and never quietly strips
them — so editing a role on an older device can't undo what a newer one granted.

## Related pages

- **[[Users & accounts|Users-and-Accounts]]** — creating accounts and assigning roles.
- **[[Signing in|Signing-In]]** — the sign-in gate these permissions sit behind.
- **[[Activity log|Activity-Log]]** — the history the *Activity history* permission covers.
- **[[Bridge API tokens|Bridge-API-Tokens]]** — how a role bounds an outside tool.
- **[[Modular UI|Modular-UI]]** — switching the Users module on and off.
