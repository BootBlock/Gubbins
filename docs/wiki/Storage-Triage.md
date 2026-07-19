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

- **Prune old history** — trim the [[activity log|Activity-Log]] back. Gubbins offers a
  **cold-storage export** of the history it's about to remove *first*, so nothing is lost.
- **Downgrade images** — drop the full-resolution copy of old images while keeping their
  thumbnails, freeing significant space at the cost of detail you rarely need.

> **💡 Tip**
> Downgrading images usually frees the most space fastest — thumbnails still show on cards and in
> lists, so day-to-day the app looks the same.

## When Gubbins stops accepting new data

If space runs out completely, Gubbins **stops accepting new data** rather than letting the write
fail half-way. Adding or editing a record, [[importing|Export-and-Import]] a file, or restoring a
[[backup|Backup-and-Restore]] is refused with a message saying storage is full, and
[[cloud sync|Cloud-Sync]] stops before it pulls anything down.

This is deliberate: a database that runs out of room mid-write is far worse than one that declines
the write, and on a device without **persistent storage** a browser short of space may discard the
whole thing.

**Deleting always works.** Removing items, pruning history and downgrading images stay available at
all times — they're how you get moving again. Free some space, and normal use resumes on its own.

> **ℹ️ Note**
> Sending your data *out* keeps working too, so you're never stuck with no way to preserve it:
> [[export|Export-and-Import]] a file, or publish to [[cloud sync|Cloud-Sync]] if you haven't yet.
> Getting a copy off the device is a good first move before you start deleting.

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
