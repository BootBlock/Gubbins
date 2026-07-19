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

## When storage is critically full

Gubbins warns you as space runs out, and takes two steps of its own so a full device can't quietly
cost you your data:

- **At 90% full** — new photos are saved as **thumbnails only**. The full-resolution copy is not
  written, which is exactly what **Downgrade images** does to older photos, so the photo still
  appears everywhere it normally would. The photo grid tells you while this is in effect; free some
  space and full-resolution images resume for anything added afterwards.
- **At 95% full** — Gubbins pauses saving altogether. Only deletions are allowed, so you can always
  reclaim space and carry on.

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
