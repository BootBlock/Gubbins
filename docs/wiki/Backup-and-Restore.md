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
- Your **device settings**.

So restoring gives you back not just your items but the whole app state.

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

## The weekly reminder (mobile)

On a phone or tablet **without [[Cloud sync|Cloud-Sync]] connected**, Gubbins shows a *"Time for a
weekly backup"* banner once a week, with a **Download archive** button that saves a full `.zip` to
your device. It's a nudge to keep a safety net where continuous auto-save isn't available.

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
