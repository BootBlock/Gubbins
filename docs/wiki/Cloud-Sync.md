# Cloud sync

Use Gubbins on more than one device? **Cloud sync** keeps them in step — through storage **you
own and control**, not a Gubbins server. There is no Gubbins account and no Gubbins backend; sync
goes through *your* folder or *your* drive.

**Where to find it:** the **Sync** screen (in the menu, when the module is enabled).

![The Sync screen: connection providers, backup, and push-to-bridge](images/sync.png)

## Where sync happens

Gubbins is **provider-agnostic**. You choose where the shared copy lives:

- **A local folder** — via your browser's **File System Access**, sync through a folder that's
  itself synced by Dropbox, OneDrive, a NAS, or similar.
- **Google Drive** — a backend-less, in-browser sign-in that stores the data in an
  **app-private** folder on your own Drive.

Each device reads and writes the shared copy, so your inventory follows you between them.

> **ℹ️ Note**
> The **Google Drive** option only appears if whoever built the copy of Gubbins you're using
> configured it with a Google sign-in identifier. If you don't see it, that build didn't include
> one — the local-folder option and [[backups|Backup-and-Restore]] work regardless.

## How conflicts are handled

When two devices change things independently, Gubbins reconciles **per item, per field** — not as
one big all-or-nothing overwrite. If you edit one thing on your phone while another device edits
something *else*, both changes are kept. It's **only** when the *same* field of the *same* thing is
changed on two devices before they sync that Gubbins has to pick one, and it does so with
**last-write-wins** — the most recent change prevails — so syncing is safe without you refereeing
every difference.

### When two devices change the same stock count

An item's **quantity** is the one thing that is *not* last-write-wins, because picking one side
would quietly lose real stock movements. Say a part has 10 on hand: you use 3 on your phone (down
to 7) while your workshop tablet uses 4 (down to 6), both offline. Last-write-wins would land on 6
*or* 7 — pretending one of those movements never happened. Instead Gubbins **adds the movements
up**: both the −3 and the −4 are kept, so after syncing every device shows **3**, the true
remainder. The same applies to receipts, sales, write-offs, transfers between locations, and every
other stock change — each one counts once, on every device, no matter where it was made. A
consumable gauge's level merges the same way.

> **ℹ️ Note**
> If two devices between them use *more* than was on hand — say both sell the last of a nearly-empty
> part — the count simply settles at **0** rather than going negative. It never silently discards a
> movement to avoid that.

### When two devices count the same shelf

A [[cycle count|Cycle-Counts-and-Audit-Day]] is the one stock change that is *not* added up, because
it isn't a movement: it says what is physically on the shelf. If a drawer reads 10, and two people
each count it and both find 8, adding up the two "−2" corrections would land on **6** — a figure
neither of them saw. Instead syncing settles on what was counted, **8**. Where the two counters
disagreed, the **later** correction stands, on the reasoning that it is the more recent look at the
shelf.

Movements made *after* a count are still added on top of it as usual, so a count is a fresh starting
point rather than the last word.

> **ℹ️ Note**
> This applies to a count that had something to correct. A count that finds the figure already
> right changes nothing and records nothing, so it leaves no mark for syncing to prefer over an
> older count from another device.

### When two devices create the same thing

Some things are identified by their **name** rather than by which device made them — tags,
contacts, and custom fields. If you add a tag called *Bolts* on your phone while your laptop is
offline, and the laptop adds its own *Bolts* too, syncing does **not** leave you with two
identical tags: Gubbins recognises them as the same thing and merges them into one.

Nothing is lost in the merge. The surviving tag carries **both** devices' items, a merged contact
keeps the checkout history from either side, and a merged custom field keeps the values recorded on
both. The same applies to a value entered twice for one field, or a specification added to the same
item on two devices — the more recent entry is kept, by the same last-write-wins rule as above.

> **ℹ️ Note**
> Matching ignores capitalisation, so *Bolts* and *bolts* are treated as one name — exactly as they
> are when you type a duplicate on a single device.

### When one item is lent out on two devices

A [[serialised item|Items]] is a single physical unit, so it can be on loan to only one borrower at
a time. Gubbins stops you lending one that's already out — but two devices offline can't see each
other, so each *can* record a loan of the same unit. When they sync, Gubbins keeps the **first**
loan (the one checked out earliest) and quietly closes the other, since the unit was only ever in
one place. The item then correctly reads as out to that one borrower, and the closed loan stays in
its [[history|Loans-Check-Out-and-In]] as a record. The Sync screen notes it in the summary when it
happens.

### When an asset is booked for the same dates on two devices

A [[booking|Bookings]] reserves one identifiable asset for a span of days, so the same asset can't
be booked twice over overlapping days. Gubbins stops you creating a clashing booking — but two
devices offline can't see each other, so each *can* reserve the same asset for overlapping dates.
When they sync, Gubbins keeps the booking that was **made first** and cancels the later one(s) that
clash with it, since the asset could only really be held by one of them. The cancelled booking stays
on record (marked *cancelled*) rather than vanishing, and the Sync screen notes it in the summary
when it happens. Bookings for the same asset on dates that *don't* overlap are all kept.

### Reviewing overwritten edits

Last-write-wins means one side's change to that same field is set aside. So you never lose that
work silently, Gubbins **notices** when an edit *you* made since your last sync is overwritten this
way and lists it for you.

When it happens, a **Conflicts** section appears on the Sync screen. Open **Review…** to see each
one side by side — your version next to the version that was kept — and choose:

- **Keep current** — accept the version that won; the note is cleared.
- **Use my version** — put *your* edit back. It syncs to your other devices on the next sync.

The same applies if another device **deleted** something you'd just edited: it's listed so you can
restore your version instead of losing it.

> **ℹ️ Note**
> This review list is **per device** — it shows the edits *this* device lost. Only genuine
> same-field clashes appear; a device simply catching up on newer changes is not a conflict and is
> never listed.

> **⚠️ Heads-up**
> The list keeps your **most recent** unreviewed conflicts, not an unlimited history. If a great
> many pile up without being reviewed — or one sits untouched for months — the oldest are cleared
> automatically so this device's storage stays healthy. Review anything you want to keep or restore
> soon after it appears rather than leaving it indefinitely.

## When Gubbins can't reach your Drive

Syncing to **Google Drive** needs a working connection. If you sync without one — on a train, in a
workshop with no signal, or while Drive is briefly unreachable — Gubbins says so in plain words
rather than showing a technical message, and distinguishes the two cases: that **this device is
offline**, or that it's online but **couldn't reach the service**.

If the attempt never got through, nothing was read and nothing was published, so your inventory is
exactly as you left it. Carry on working and sync again when you're back on a connection. (A
connection that drops *part-way* through is a different case, covered in
[[when your changes can't be published|#when-your-changes-cant-be-published]] below.)

> **ℹ️ Note**
> The **local folder** option doesn't go over the network at all — Gubbins writes the shared copy
> straight into the folder, and whichever cloud tool syncs that folder catches up in its own time.
> So a folder sync works offline; it's the folder's own service that needs the connection.

> **ℹ️ Note**
> Everything *except* syncing keeps working offline — adding items, counting stock, checking things
> out. See [[How your data is stored|How-Your-Data-Is-Stored]].

## When the shared copy can't be read

Your devices meet through a single **shared copy** of your inventory — a file in the folder or
Drive account you connected. Sometimes it can't be read at the moment you sync: your cloud tool
may still be downloading it, another device may be part-way through writing it, or you may have
reconnected the wrong folder or account.

Gubbins **stops** the sync and tells you, rather than pressing on. This matters because carrying on
would mean uploading *this* device's inventory as the shared copy — and anything that existed only
on your other devices would be gone from it. Waiting a moment and syncing again is almost always
all that's needed.

If the shared copy has genuinely disappeared — you emptied the folder, or deleted the file — the
message offers **Publish this device's data**, which starts a new shared copy from what's on this
device. Use it only when you're sure: it can't bring back records that lived solely on the other
devices.

> **💡 Tip**
> Before publishing a fresh shared copy, sync your *other* devices first if you can, or take a
> [[backup|Backup-and-Restore]] from them. That way the new shared copy starts complete.

> **💡 Tip**
> The local-folder option is the most flexible: point it at any folder your existing cloud tool
> already syncs, and Gubbins rides on top of the service you already trust.

> **ℹ️ Note**
> Sync moves your data through storage *you* control. Gubbins never sees it — there's no server in
> the middle. The Google Drive option uses Google's own sign-in and stays within an app-private
> folder. See [[Privacy & security|Privacy-and-Security]].

## When your changes can't be published

Syncing happens in two halves: Gubbins reads the shared copy and merges it into this device, then
publishes the merged result back. If your connection drops — or the folder's cloud drive goes
away — in between, the first half has already happened and the second hasn't.

Gubbins says so plainly rather than reporting a blanket failure, because the difference matters:
this device **is** now up to date with your others; it's your others that haven't caught up. The
summary tells you what was brought in, the screens refresh to show it, and any
[[overwritten edits|#reviewing-overwritten-edits]] are listed for review exactly as they would be
after a complete sync. Nothing is lost — syncing again publishes your changes.

> **ℹ️ Note**
> Until that next sync succeeds, your other devices won't see the changes made on this one. If
> you're about to move to another device, sync again first.

## Sharing your settings too

By default sync carries your **records** — items, locations, loans and the rest — and leaves each
device's **settings** to itself. If you'd rather your theme, thresholds and saved searches followed
you around as well, the **Shared settings** section on this screen turns that on, per settings group
and per device. See **[[Sharing settings between devices|Sharing-Settings-Between-Devices]]**.

## Sync vs backup

> **ℹ️ Note**
> **Sync** keeps devices *continuously* in step. A **[[backup|Backup-and-Restore]]** is a
> *point-in-time* copy you can restore from. They complement each other — sync for day-to-day,
> backups for safety and history.

## Related pages

- **[[Sharing settings between devices|Sharing-Settings-Between-Devices]]** — carrying preferences,
  not just records.
- **[[Backup & restore|Backup-and-Restore]]** — point-in-time copies.
- **[[How your data is stored|How-Your-Data-Is-Stored]]** — the local-first model.
- **[[Storage triage|Storage-Triage]]** — keeping storage healthy.
