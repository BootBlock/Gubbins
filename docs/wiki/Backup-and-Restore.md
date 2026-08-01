# Backup & restore

A **backup** is a single portable file containing your whole Gubbins — data, images and settings —
that you can keep safe and **restore** from later. It's your insurance against a lost device or a
browser wiping its storage.

**Where to find it:** the **Sync** screen → **Backup & restore** (in the menu, when the module is
enabled).

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

> **💡 Tip**
> A backup carries settings **on demand**, in one direction, to a file. If what you actually want is
> for a preference changed on one device to show up on the others, that is a separate opt-in —
> see **[[Sharing settings between devices|Sharing-Settings-Between-Devices]]**. The groups you
> untick here also stay out of the file when settings are being shared.

## Restoring: Merge or Replace

There are two ways to restore:

- **Merge** — bring the backup's data *into* your current inventory without destroying what's
  there. Non-destructive.
- **Replace** — wipe the current data and restore the backup *exactly*. Destructive.

> **ℹ️ Note**
> **Merge** only ever adds or updates — it never removes a record you still have, even one the
> backup was taken after you'd deleted. Deletions you've made since are remembered too, so
> [[Cloud Sync|Cloud-Sync]] won't bring those records back from another device. Do expect a merge
> to restore records that *are* in the backup but you've since deleted — that's the point of it.

> **⚠️ Heads-up**
> **Replace** overwrites everything currently in Gubbins. It's deliberately well-guarded — an
> automatic restore-point is saved first, you get an impact preview and a storage-space check, and
> you must type-to-confirm — but it *is* destructive. When in doubt, **Merge**.

### The restore point has to actually land

The restore point is the undo for an overwrite that cannot otherwise be undone, so Gubbins doesn't
just *offer* you the file and carry on — it waits until the copy is really there.

- On browsers that can save a file properly (Chrome, Edge and other Chromium browsers on desktop),
  you're asked **where to put it**. Once it's written, the restore runs. Close that dialog without
  choosing anywhere and nothing is restored.
- Everywhere else — Firefox, Safari, and apps that open web pages inside themselves — a browser can
  start a download without ever saying whether it finished. There, Gubbins names the file and asks
  you to check you have it. Answer **Cancel — change nothing** and your data is left exactly as it
  was.

> **⚠️ Heads-up**
> Don't wave that question through. A download can be refused, cancelled or silently dropped —
> most often on a phone, or when the disk is full — and the whole point of the copy is to exist
> before anything is overwritten. Go and look for the file first.

> **ℹ️ Note**
> Once a backup or a restore is genuinely under way, the dialog stays put until it finishes —
> pressing Escape, clicking outside it and the ✕ all wait, and so does switching between the
> **Create backup** and **Restore** tabs. Leaving wouldn't call the work off; on a **Replace** it
> would only hide whether your data came back or something went wrong part-way. Picking and
> reading a backup file is not "under way" — nothing has been changed yet, so you can still back
> out of that at any point.

> **💡 Tip**
> Take a backup before any big change — a large import, a bulk edit, or a Replace restore. The
> automatic restore-point has your back, but your own recent `.zip` is the surest safety net.

### If some of the images can't be saved

Your records go in first and the full-resolution photos are written afterwards, so the photos are
what a device short on space runs out of room for. A **Replace** is likeliest to hit it, because it
saves a restore point of your current data before it starts — a second full copy of your database,
written moments earlier.

If it happens the restore is **not** undone, because by then it has already taken effect: your
items, locations and settings are in place, and the photos that wouldn't fit are the only thing
missing. So Gubbins says that rather than calling the whole restore a failure — *"3 images could
not be saved to this device"* — and finishes the job either way. It carries on past a photo it
can't write, too, so a single large one doesn't cost you all the ones after it.

Restoring a full archive from the recovery screen is the one case that then stops and asks you to
**reload**, with a button to do it: that restore replaces the database file itself, which closes
the one Gubbins was using, and reloading is what picks the restored one up. Everywhere else Gubbins
carries on by itself — reloading without asking where it has to, and simply refreshing the screen
where it doesn't.

> **💡 Tip**
> The photos are still in the `.zip`. Free up some space — **[[Storage triage|Storage-Triage]]** is
> the quickest way — then restore the same file again with **Merge**. Everything already there is
> simply written over, and the images that were missing land this time.

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
> screen names anything left out, so you know what the file holds before you rely on it. If
> *nothing* at all can be read, it says so and no file is saved — a backup you can't rely on is
> worse than none, because the next step this screen offers clears your data.

> **💡 Tip**
> If the backup can't be made, try **Download raw .sqlite binary** underneath it. That one only has
> to open your database rather than read through it, so it often works when the backup doesn't —
> and it's worth having before you reset, even though it can't be restored into Gubbins afterwards.

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
saves a copy of your current database first and waits for it to land, so a restore that turns out
wrong can be undone.

Every `.zip` backup also carries its own packing list: how many items and images it holds, which
optional parts were included, and a fingerprint of each one. When you pick a file to restore,
Gubbins compares what it actually reads against that list. If a part is missing, or its contents no
longer match the fingerprint taken when the backup was written, the file is refused and you're told
which part is at fault — so a backup that quietly lost data can't restore as though it were complete.
Backups made before this check existed are still perfectly usable; they're simply checked against
their item and image counts alone.

If the packing list itself is the damaged part, Gubbins can no longer tell whether the backup's exact
database copy suits this version — so **Replace everything** is declined rather than risked, and it
says so before anything is touched. **Merge** still works, and brings your records across without
replacing the database file.

> **⚠️ Heads-up**
> Those checks are a safety net, not a substitute for judgement. Treat a backup like any other file
> you'd open: restore from your own archives, or from someone you trust. The same goes for a
> **[[Cloud sync|Cloud-Sync]]** folder shared with other people — anyone who can write to it can put
> a file there for your devices to pick up.

## A copy from another version is refused, not restored

A `.sqlite` copy or a `.zip` archive can be perfectly intact and still be one this version of Gubbins
cannot open — because it was written before an update changed the shape of the database. That's the
ordinary situation while Gubbins is pre-1.0, and it matters most for the weekly archive below, where
the file you reach for may be several releases old.

So every restore that replaces the database file outright also checks *which version made it*, and
stops there if it doesn't match: your current database is left exactly as it was. Gubbins then says
what to do instead — take **Back up everything (.zip)** from the recovery screen and restore that
with **Merge**, which re-applies your records onto the new database shape rather than putting the old
database file back.

As with a damaged file, you can still override it after a second, deliberate confirmation — and a
copy of your current database is saved first either way, so you can get straight back to where you
were. That copy is not optional: if it can't be saved, or you tell Gubbins it never arrived, the
restore is cancelled and nothing is touched.

> **ℹ️ Note**
> This is the same check that makes **Replace everything** decline a backup whose exact database copy
> came from a different version. It now applies to **Restore raw .sqlite binary** and **Restore full
> archive (.zip)** on the recovery screen too, which previously went ahead and left Gubbins unable to
> start on the next load.

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
- **[[Sharing settings between devices|Sharing-Settings-Between-Devices]]** — the same settings
  groups, kept in step continuously rather than copied into a file.
- **[[Export & import|Export-and-Import]]** — open-format exports.
- **[[Storage triage|Storage-Triage]]** — reclaiming space.
- **[[How your data is stored|How-Your-Data-Is-Stored]]** — why a browser can clear your data, and
  what Gubbins shows if it does.
