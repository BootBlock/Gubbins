# Storage triage

Because Gubbins stores everything **on your device**, its data takes up real storage — mostly
images and history. The **storage triage** dashboard shows where the space is going and helps you
reclaim it safely.

**Where to find it:** the storage triage entry in **Settings → Data & storage** (and from the
storage-space banner if you're running low).

## Seeing where space goes

Triage breaks down your storage **per table** — how much is images, how much is history, and so
on — so you can see what's actually filling it up before deciding what to do.

## Reclaiming space

Two safe cleanups, each keeping a copy of anything it removes:

- **Prune old history** — trim the [[activity log|Activity-Log]] back. Gubbins saves a
  **cold-storage export** of the history it's about to remove *first*, and deletes nothing until
  that file is safely yours.
- **Downgrade images** — drop the full-resolution copy of old images while keeping their
  thumbnails, freeing significant space at the cost of detail you rarely need.

> **💡 Tip**
> Downgrading images usually frees the most space fastest — thumbnails still show on cards and in
> lists, so day-to-day the app looks the same.

### The cold-storage export has to land first

Pruned history doesn't come back — not from another device either, because Gubbins remembers where
you pruned to and won't re-download entries from before that point. The export is the only copy, so
it isn't merely offered:

- On browsers that can save a file properly (Chrome, Edge and other Chromium browsers on desktop),
  you're asked **where to put it**, and the entries are removed once it's written. Close that
  dialog and nothing is deleted.
- Everywhere else — Firefox, Safari, and apps that open web pages inside themselves — Gubbins names
  the file and asks you to check you have it. Say you haven't and your history is left untouched;
  the app tells you plainly that nothing was deleted.

> **⚠️ Heads-up**
> This is the cleanup most worth being careful with, and it's the one you reach for when the device
> is *short of space* — precisely when a save is most likely to fail. Find the file before you
> confirm.

> **ℹ️ Note**
> Gubbins also tidies up after itself in the background: when a record is deleted, the
> full-resolution image files it no longer needs are cleared automatically, so they can't quietly
> pile up and eat into your space. You don't have to do anything for this to happen.

## When storage is critically full

Gubbins warns you as space runs out, and takes two steps of its own so a full device can't quietly
cost you your data:

- **At 90% full** — new photos are saved as **thumbnails only**. The full-resolution copy is not
  written, which is exactly what **Downgrade images** does to older photos, so the photo still
  appears everywhere it normally would. The photo grid tells you while this is in effect; free some
  space and full-resolution images resume for anything added afterwards.
- **At 95% full** — Gubbins pauses saving altogether. Only deletions are allowed, so you can always
  reclaim space and carry on.

The pause covers everything that would add data, not just editing a record:
[[importing|Export-and-Import]] a file and restoring a [[backup|Backup-and-Restore]] are refused
with a message saying storage is full, and [[cloud sync|Cloud-Sync]] stops before it pulls anything
down. Declining the write is deliberate — a database that runs out of room part-way through is far
worse than one that says no.

> **💡 Tip**
> Sending your data *out* keeps working, so you're never stuck with no way to preserve it:
> [[export|Export-and-Import]] a file, or publish to [[cloud sync|Cloud-Sync]] if you haven't yet.
> Getting a copy off the device is a good first move before you start deleting.

> **⚠️ Heads-up**
> A photo added while storage was critically full has no full-resolution copy to recover later —
> not from a [[backup|Backup-and-Restore]] either, because the copy was never made. Free space
> first if the detail matters.

> **ℹ️ Note**
> [[Install|Installing-Gubbins]] Gubbins and grant **persistent storage** so the browser won't
> evict your data when the device runs low. Triage helps you *manage* space; persistent storage
> stops the browser reclaiming it out from under you.

> **⚠️ Heads-up**
> Cleanups remove data from *this* device to save space. Keep a [[backup|Backup-and-Restore]] if
> you might want the full-resolution images or old history back later — the cold-storage export
> covers pruned history, but a backup is the complete safety net.

## Related pages

- **[[Backup & restore|Backup-and-Restore]]** — a full copy before you prune.
- **[[How your data is stored|How-Your-Data-Is-Stored]]** — why storage fills up.
- **[[Activity log|Activity-Log]]** — the history you can prune.
- **[[Self-hosting with Docker|Self-Hosting-with-Docker]]** — worth knowing that running Gubbins
  on your own server does **not** give you more space: the data still lives in your browser.
