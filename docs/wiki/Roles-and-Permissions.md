# Roles & permissions

A **role** is a named set of permissions you hand to one or more people — *"Stocker"*, *"Viewer"*,
*"Workshop lead"*. Rather than ticking boxes for every person, you describe the job once and assign
it.

**Where to find it:** the **Roles** section at the bottom of the **Users** screen (part of the
[[Users module|Modular-UI]]).

![The role editor: a grid of permissions with a row per area of Gubbins and a column per action](images/users-role-editor.png)

## The roles Gubbins ships with

Four roles come ready to use. You can retune what any of them allows, but they can't be deleted —
people are assigned to them.

| Role | What it allows |
| --- | --- |
| **Administrator** | Everything, including managing users and roles |
| **Manager** | Everything across inventory, projects and settings, but can't manage users |
| **Stocker** | Add and edit items, move stock and run counts. No deleting, and no activity history, projects, contacts, suppliers, purchase orders, bookings, user accounts, sync or bridge setup |
| **Viewer** | Look at inventory, projects, contacts, suppliers, purchase orders, bookings and reports; change nothing. No activity history, user accounts, sync or bridge setup |

Add your own with **Add role** whenever none of these quite fits. Role names are matched **ignoring
case, in any language**, so `Workshop Lead` and `WORKSHOP LEAD` are one role rather than two that
look alike.

> **ℹ️ Note**
> These four are shown in your [[interface language|Language-and-Region]]. Rename one — or rewrite
> its description — and your own wording is what Gubbins shows from then on, whatever language you
> switch to.

## How permissions are described

Permissions are a grid: a **row for each area** of Gubbins and a **column for each action**.

- **Areas** are the things you work with — items, stock levels, locations, categories, tags,
  projects, contacts, suppliers, purchase orders, bookings, loans, maintenance, wishlist, reports —
  plus a few that cut across the app: activity history, settings, users and roles, backups,
  [[sync|Cloud-Sync]] and the [[bridge|Bridge-Overview]].
- **Actions** are **View**, **Change** and **Delete**, with a couple of sensible exceptions.
  **Stock levels** has no Delete — stock is written down or written off, never deleted. **Activity
  history** is View and Delete only, because the ledger is a record of what happened and isn't
  edited. **Users and roles** is View and Manage, because anyone who can edit an account could grant
  themselves anything anyway.

> **ℹ️ Note**
> **Change** covers an entity's own details *and* the things attached to it — an item's attachments,
> photos, capabilities and BOM lines are all part of changing the item. **Delete** means deleting
> the item itself.

## What **View** actually does

Most areas have a screen of their own, and for those, **View** decides whether it opens. Take
**View** away and the screen disappears from the navigation menu, from the Dashboard's tile grid,
from the keyboard shortcuts and from the [[command palette|Command-Palette-and-Shortcuts]] — and
typing the address by hand lands on a short "your role doesn't allow this" page instead. Any
[[dashboard|Dashboard-and-Widgets]] card summarising that area drops off the board too, so nothing
quietly reports what the screen won't show.

Some areas have no screen to hide, and their **View** governs the data wherever it is reached
instead:

- **Activity history → View** covers the [[activity log|Activity-Log]] screen *and* the per-item
  and per-location history tabs, which are the same record seen from a different angle.
- **Backups → View** allows creating a [[backup|Backup-and-Restore]], because a backup file is a
  copy of the whole database rather than a page to look at. Backup & restore lives on the
  [[Sync|Cloud-Sync]] screen, so that screen opens for a role granted backups even without
  **Sync → View**.
- **Loans → View** and **Maintenance → View** govern the [[Upcoming|Upcoming-Agenda]] and
  [[Alerts|Alerts]] entries drawn from them, since neither has a screen of its own.
- **Settings** is the exception that stays open to everyone: it holds this device's own
  preferences — [[appearance|Appearance-and-Theming]], [[language|Language-and-Region]] — rather
  than your inventory, so **Settings → Change** is the permission that bites there, not View.

> **ℹ️ Note**
> A few areas — **Stock levels**, **Locations**, **Categories** and **Wishlist** — currently show
> a **View** box that nothing in the app checks: their records are read wherever an item shows
> them, and Gubbins does not gate an item's own page field by field. Their **View** does take
> effect for the [[bridge|Bridge-Overview]], where locations and categories are separate
> endpoints. Their **Change** and **Delete** boxes work everywhere.

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
  needs **Bridge → Change**.
- An entry that takes other records with it needs *their* permission too. *All items* removes each
  item's activity history, checkouts, maintenance schedules and supplier parts, so it needs
  **Activity history → Delete**, **Loans → Change**, **Maintenance → Delete** and **Suppliers →
  Delete** as well as **Items → Delete** — the same permissions the entries for those records ask
  for on their own.
- **Erase everything** — the factory reset — needs *all* of those at once, plus four the entries
  never ask for on their own: **Users and roles → Manage**, **Stock levels → Change**, **Bookings →
  Delete** and **Wishlist → Delete**. It deletes the whole database rather than a list of records,
  so it reaches accounts, roles, stock levels, bookings and the wishlist as well.
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

A role also governs what an outside tool can do. An [[API token|Bridge-API-Tokens]] minted against
an account is held to that account's role, so the same limits follow it out of the app. The bridge
checks the permission on **every request**, against the data rather than a screen: a role without
**Activity history → View** is refused the activity feed itself, and one without **Items → View**
is refused the item endpoints, the search and the OData service alike.

> **⚠️ Heads-up**
> Permissions decide what Gubbins *lets someone do in the app*. They are not a lock on the data
> itself — anyone with access to this device's files can still read everything, and anyone using
> the app can switch the Users module off from the [[Modules|Modular-UI]] screen, which takes the
> sign-in gate down with it. Roles keep honest people out of each other's way on a shared device;
> they are not a security barrier against whoever holds it. See
> [[Privacy & security|Privacy-and-Security]].

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
