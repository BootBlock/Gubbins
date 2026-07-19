# Backup & restore

A **backup** is a single portable file containing your whole Gubbins — data, images and settings —
that you can keep safe and **restore** from later. It's your insurance against a lost device or a
browser wiping its storage.

**Where to find it:** the backup & restore tools (Sync / Data & storage areas).

## What's in a backup

A backup is one portable **`.zip`** that bundles:

- A version-guarded **JSON snapshot** of your data.
- An exact copy of the **`.sqlite`** database.
- **Full-resolution images**.
- Your **device settings** — as much or as little of them as you choose (see below).

So restoring gives you back not just your items but the whole app state.

## Choosing which settings travel

Settings aren't all-or-nothing. Tick **App settings & preferences** when creating a backup and a
list of settings **groups** appears underneath — appearance, language and units, item cards,
dashboard, alerts, keyboard shortcuts, scanning, printed catalogue, reports, saved searches, and a
**This device** group. Tick only the groups you want the file to carry (or use **Select all** /
**Select none**).

Restoring works the same way in reverse: after you pick a backup file, Gubbins lists the groups
that file actually contains and lets you choose which ones to apply here. Anything you leave
unticked is left exactly as it is on this device — restoring your theme won't disturb your
thresholds, and vice versa.

> **ℹ️ Note**
> **This device** — the bridge address, kiosk mode, a connected scale and any prompts you've
> dismissed — is **off by default at both ends**, because it usually describes one particular
> machine rather than how you like Gubbins to work. Tick it when creating *and* when restoring if
> you're rebuilding the *same* device.

> **💡 Tip**
> No usable credential is ever included in a backup, whatever you tick. The bridge URL and token
> you set up on a device stay on that device, so you'll re-enter them after restoring; and an
> [[API token|Bridge-API-Tokens]] itself is never stored anywhere — only a scrambled fingerprint
> of it — so a `.zip` you share or store elsewhere can't leak one.

## Restoring: Merge or Replace

There are two ways to restore:

- **Merge** — bring the backup's data *into* your current inventory without destroying what's
  there. Non-destructive.
- **Replace** — wipe the current data and restore the backup *exactly*. Destructive.

> **⚠️ Heads-up**
> **Replace** overwrites everything currently in Gubbins. It's deliberately well-guarded — an
> automatic restore-point is taken first, you get an impact preview and a storage-space check, and
> you must type-to-confirm — but it *is* destructive. When in doubt, **Merge**.

> **💡 Tip**
> Take a backup before any big change — a large import, a bulk edit, or a Replace restore. The
> automatic restore-point has your back, but your own recent `.zip` is the surest safety net.

## Backing up when Gubbins won't start

If Gubbins can't open your database — most often because an update changed its shape while Gubbins
is still pre-1.0 — the recovery screen offers **Back up everything (.zip)**. It builds a normal
backup out of the database as it stands, so you're never asked to reset without a copy you can
bring back.

Restore it with **Merge** once Gubbins starts again. Merge re-applies your records onto the new
database shape, which is exactly what's needed after a reset; **Replace** would put the old database
file back and run into the same problem, so Gubbins refuses that combination and says so.

> **ℹ️ Note**
> Because the database is in an unexpected shape, a part of it occasionally can't be read. The
> screen names anything left out, so you know what the file holds before you rely on it.

## Only restore files you trust

A backup file describes changes to make to your inventory — including which entries to remove — so
restoring one hands it a good deal of authority over your data. Gubbins checks a file over before
applying any of it, and refuses the **whole** file if it doesn't look like a genuine Gubbins backup:
if it isn't valid, was made by a newer version, or refers to data that isn't part of Gubbins, nothing
is restored and your current inventory is left untouched.

A file can also be a genuine Gubbins database and still be *damaged* — a download that was cut off
part-way, a copy taken from a failing drive, or a cloud file that never finished syncing. Before
restoring a raw `.sqlite` database or a full `.zip` archive from the recovery screen, Gubbins checks
for exactly that: it confirms the file is complete, then opens it to check the data inside is intact.
If something is wrong it says what, and nothing is overwritten.

You can still go ahead — a damaged copy is sometimes all that's left, and most of the records in one
are usually still readable — but it takes a second, deliberate confirmation. Either way, Gubbins
downloads a copy of your current database first, so a restore that turns out wrong can be undone.

Every `.zip` backup also carries its own packing list: how many items and images it holds, which
optional parts were included, and a fingerprint of each one. When you pick a file to restore,
Gubbins compares what it actually reads against that list. If a part is missing, or its contents no
longer match the fingerprint taken when the backup was written, the file is refused and you're told
which part is at fault — so a backup that quietly lost data can't restore as though it were complete.
Backups made before this check existed are still perfectly usable; they're simply checked against
their item and image counts alone.

> **⚠️ Heads-up**
> Those checks are a safety net, not a substitute for judgement. Treat a backup like any other file
> you'd open: restore from your own archives, or from someone you trust. The same goes for a
> **[[Cloud sync|Cloud-Sync]]** folder shared with other people — anyone who can write to it can put
> a file there for your devices to pick up.

## The weekly reminder (mobile)

On a phone or tablet **without [[Cloud sync|Cloud-Sync]] connected**, Gubbins shows a *"Time for a
weekly backup"* banner once a week, with a **Download archive** button that saves a full `.zip` to
your device. It's a nudge to keep a safety net where continuous auto-save isn't available.

Gubbins always tells you how it went: a confirmation naming the downloaded `.zip` when the archive
succeeds, or — if it couldn't be created — a message saying so, with a **Try again** button. The
reminder stays put until a backup has actually been taken.

> **💡 Tip**
> Not ready right now? Dismiss the banner with its **✕** and it stays hidden for a week — it only
> comes back if you still haven't taken a backup by then. Downloading an archive (or connecting
> Cloud sync) clears it too.

## Backup vs sync

> **ℹ️ Note**
> A backup is a *point-in-time* copy you keep. **[[Cloud sync|Cloud-Sync]]** keeps devices
> *continuously* in step. Use both: sync for everyday, backups for safety and history.

## Related pages

- **[[Cloud sync|Cloud-Sync]]** — continuous multi-device sync.
- **[[Export & import|Export-and-Import]]** — open-format exports.
- **[[Storage triage|Storage-Triage]]** — reclaiming space.
