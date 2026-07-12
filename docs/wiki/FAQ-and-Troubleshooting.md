# FAQ & troubleshooting

Quick answers to common questions. If something isn't here, the linked pages go deeper.

## General

**Do I need an account?**
No. Gubbins has no account and no sign-up — it runs [[locally in your
browser|How-Your-Data-Is-Stored]].

**Does it work offline?**
Yes, fully. Everything runs on your device; no connection is ever required.

**Where is my data stored?**
In your browser's private storage on your device — see [[How your data is
stored|How-Your-Data-Is-Stored]]. Nothing is uploaded unless you turn on an optional feature
pointed at your own storage.

**Is my data sent anywhere?**
No — see [[Privacy & security|Privacy-and-Security]]. Only features *you* enable (sync, the
bridge, scraping) ever move data, and always to destinations you choose.

## Using Gubbins

**A feature this wiki describes isn't showing up. Why?**
It's almost certainly switched off in [[Modular UI|Modular-UI]]. Turn it back on there — your data
is untouched.

**How do I add a lot of items at once?**
Paste or import a list — see [[Export & import|Export-and-Import]]. Coming from another app? See
[[Migrating from another tool|Migrating-from-Another-Tool]].

**How do I use Gubbins on my phone *and* my computer?**
Turn on [[cloud sync|Cloud-Sync]] to your own folder or drive, or move a
[[backup|Backup-and-Restore]] across.

**Why does an item show "Unassigned" for location?**
It hasn't been put in a [[location|Locations-and-Stock]] yet. Assign one on the item, or drag its
card onto a location.

## Troubleshooting

**My data disappeared / the app is empty.**
The most common cause is the browser clearing its storage for Gubbins. Restore from a
[[backup|Backup-and-Restore]] or re-[[sync|Cloud-Sync]]. To prevent it, [[install the
app|Installing-Gubbins]] and grant **persistent storage**.

**I'm running low on storage.**
Use [[storage triage|Storage-Triage]] to see what's using space and reclaim it (downgrading old
images usually helps most), keeping a [[backup|Backup-and-Restore]] first.

**Notifications aren't arriving.**
They need the app [[installed|Installing-Gubbins]] and permission granted, and support varies by
device (limited on iOS). See [[Reminder notifications|Reminder-Notifications]].

**The camera scanner won't start.**
It needs the [[Live camera scanning|Camera-Scanning]] capability enabled and camera permission.
Printed [[labels|QR-Codes-and-Label-Printing]] work regardless.

**A clear barcode won't scan.**
Centre it in the framing box — Gubbins reads the part of the picture inside your viewfinder, so it
needn't fill the whole screen. Good light and a steady hand help; if it still won't read, type or
paste the number into the box at the bottom. Gubbins reads QR codes and the common retail barcodes
(EAN‑13/8, UPC‑A/E) plus Code 128/39 part labels. See [[Camera scanning|Camera-Scanning]].

**I scanned a barcode and got a website link.**
That packaging had a **marketing QR code** (a link) as well as its barcode, and the camera picked
up the QR. Gubbins won't save a link as a barcode — it offers to open it instead. Aim at the
product's own barcode (the striped one) to record that.

**After an update, Gubbins asks me to reset or purge my data. Why?**
Gubbins is still in early, rapid development (before version **1.0**). As new features land, the
shape of the local database changes — and while it's this young, those changes aren't migrated
automatically. When an update needs a newer database than your device has, Gubbins can't carry your
existing data forward, so it asks you to start fresh. **This is expected before 1.0**, not a bug or
data corruption. On that screen you can back up your data first (download a raw `.sqlite` copy or a
JSON export) and then reset to continue. Once Gubbins reaches 1.0, updates will preserve your data.

> **⚠️ Heads-up**
> Take a [[backup|Backup-and-Restore]] regularly while Gubbins is pre-1.0, so a schema reset never
> costs you more than the changes since your last backup.

> **💡 Tip**
> Whatever the issue, a recent [[backup|Backup-and-Restore]] is the best safety net — take one
> before big changes and you can always get back to a known-good state.

## Related pages

- **[[Privacy & security|Privacy-and-Security]]** — the privacy details in full.
- **[[Backup & restore|Backup-and-Restore]]** and **[[Storage triage|Storage-Triage]]** — keeping
  data safe and lean.
- **[[Modular UI|Modular-UI]]** — why a feature might be hidden.
