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

**Gubbins says my browser isn't supported — but my browser is up to date.**
Then it very likely *is* supported, and something else is withholding the storage Gubbins needs.
Read that screen: it works out the specific cause and says what to try. Usually it's an insecure
`http://` address, a content blocker or privacy extension stopping one of Gubbins' scripts,
blocked cookies/site data, or a private/incognito window — none of which mean your browser can't
run Gubbins. Only when all of those are ruled out does the screen conclude it's the browser. See
[[Supported browsers|Installing-Gubbins]] for the full list of causes.

**Gubbins is stuck on "Preparing secure storage…".**
That's the one-time setup Gubbins does on your first visit, and it normally finishes on its own in
a moment. If it lingers, press **Reload**. If it then reports a different cause, follow the advice
it gives — see [[Supported browsers|Installing-Gubbins]].

**My data disappeared / the app is empty.**
The most common cause is the browser clearing its storage for Gubbins. Restore from a
[[backup|Backup-and-Restore]] or re-[[sync|Cloud-Sync]]. To prevent it, [[install the
app|Installing-Gubbins]] and grant **persistent storage**.

**I'm running low on storage.**
Use [[storage triage|Storage-Triage]] to see what's using space and reclaim it (downgrading old
images usually helps most), keeping a [[backup|Backup-and-Restore]] first.

**A change I made undid itself.**
Gubbins shows edits instantly and saves them in the background, so if a save is rejected the
change is rolled back and you'll see it revert — an item reappearing after a delete, a star
un-starring itself, a quantity or gauge snapping back. A message appears in the corner saying what
failed and why; read it rather than simply retrying, as the same save will usually fail again.
Running out of space is a common cause — see [[storage triage|Storage-Triage]].

**An error message mentions a "constraint" or looks like database jargon.**
It shouldn't — Gubbins explains what went wrong in plain language, and the most common causes tell
you exactly what to do: a name or username that's already taken, a required value left empty, or
something still linked to another record. Saving is also paused when the device runs out of space,
which the message will say — see [[storage triage|Storage-Triage]]. If you do see a technical
message, that's worth [[reporting|About-and-Diagnostics]].

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

**Which version am I running?**
It's the first thing on the **About** screen — **Settings → App → About Gubbins**. See
[[About & diagnostics|About-and-Diagnostics]].

**How do I report a problem?**
Open **Settings → App → About Gubbins**, expand **Diagnostics** and press **Refresh**, then press
**Open issue on GitHub** — the report arrives with your version, browser and device details
already filled in, so there's no back-and-forth working out what you're running. Nothing is
gathered until you press **Refresh**, and your inventory is never included. See
[[About & diagnostics|About-and-Diagnostics]].

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

**Gubbins says "Device clock is wrong". What does that mean?**
Gubbins decides a great many things from the date: whether stock has passed its best-before,
whether a loan is overdue, whether an item is due for a service, and whether stock has gone idle.
All of those answers come from your device's own clock — so if that clock is wrong, the answers are
wrong too, and nothing on screen would look unusual.

To stop that happening, Gubbins checks your device's clock against the time reported by the server
it was loaded from. If the two disagree by more than a few minutes, it **corrects the difference
itself** — expiry, overdue and service dates are then judged against the real time rather than your
device's idea of it — and shows a small marker at the bottom of the screen so you know the
correction is being applied. The marker tells you which way your clock runs (for example, that your
device reads three hours ahead).

Nothing is broken, and your data is untouched: the correction only affects *judgements* about dates,
never the dates recorded against your items. The fix is to correct your device's clock — on most
systems, turning on "set time automatically" in the date and time settings is enough. Once it agrees
again, the marker disappears on the next launch.

> **ℹ️ Note**
> Gubbins can only make this check when it can reach the network. Offline, it keeps using the last
> correction it worked out, so a device with a known-wrong clock still judges dates correctly.

> **💡 Tip**
> Whatever the issue, a recent [[backup|Backup-and-Restore]] is the best safety net — take one
> before big changes and you can always get back to a known-good state.

## Related pages

- **[[About & diagnostics|About-and-Diagnostics]]** — your version, and the details to attach when
  reporting a problem.
- **[[Privacy & security|Privacy-and-Security]]** — the privacy details in full.
- **[[Backup & restore|Backup-and-Restore]]** and **[[Storage triage|Storage-Triage]]** — keeping
  data safe and lean.
- **[[Modular UI|Modular-UI]]** — why a feature might be hidden.
