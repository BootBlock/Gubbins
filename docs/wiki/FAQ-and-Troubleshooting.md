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

**Gubbins says it's already open elsewhere, or that it can't check for other tabs.**
Your data can only be open in one tab or window at a time — that's what keeps two copies of Gubbins
from writing over each other. If it says Gubbins is **already open elsewhere**, close the other tab
and this one switches over by itself. If instead it says it **can't check** for other tabs, the
browser didn't answer when Gubbins asked; **Reload and try again** usually clears it. Gubbins stops
rather than guessing, so if you're certain no other tab has Gubbins open, choose **This is my only
tab — open anyway** to carry on. That choice applies to that tab only and is forgotten once you
close it.

**Gubbins says it lost its connection to my data, or that the database took too long to respond.**
Gubbins keeps your data in a background component of the page, and very occasionally that component
stops — a browser reclaiming memory is the usual reason. When it does, Gubbins tells you instead of
leaving the screen spinning, and **reloading the page** restores it. Nothing is lost: your data is
on the device, not in that component. If it says the database merely took too long, try the action
again first; reload only if it keeps happening.

**Gubbins can't reach my [[bridge|Bridge-Overview]], but the bridge is definitely running.**
If you have *just* entered the bridge's address, look for a **Reload to connect to this bridge**
notice on the **Sync** screen and press it. Gubbins only contacts addresses it knew about when it
started, so a brand-new address needs one reload before it can be used — and until then a perfectly
healthy bridge looks unreachable. If there's no such notice, the address really isn't answering:
check the bridge is running, that the address and port match what it printed on startup, and that
anything in between (a firewall, another machine) allows it.

**Gubbins looks broken since it updated — but my data is fine.**
Gubbins keeps a copy of itself on your device so it works offline, and occasionally that copy is
what's wrong: an update that only half applied, or a version with a bug in it. **Settings → Danger
zone → Reinstall app files** throws that copy away and downloads Gubbins fresh. It deletes
**nothing** — your items, photos and settings are untouched — so it's always safe to try before
anything more drastic. See [[Danger zone|Danger-Zone-Erasing-Data]].

**I get a blank white screen and nothing loads at all.**
If Gubbins won't start far enough to reach its own settings, add `?recover=1` to the end of the
address and press Enter — so `https://bootblock.github.io/Gubbins/?recover=1`. That does the same
thing as *Reinstall app files* above, but from outside the app: it discards the stored copy of
Gubbins and reloads the latest version. **Your data is not touched.** Once it finishes, the
address returns to normal on its own.

> **💡 Tip**
> Try this before "clear site data" in your browser settings. Clearing site data also deletes your
> inventory; `?recover=1` deliberately doesn't.

**My data disappeared / the app is empty.**
The most common cause is the browser clearing its storage for Gubbins. Where Gubbins can tell this
has happened it says so on startup, on a **“Your Gubbins data is gone”** screen — see [[How your
data is stored|How-Your-Data-Is-Stored#if-your-data-disappears]]. Restore from a
[[backup|Backup-and-Restore]] or re-[[sync|Cloud-Sync]] **before** adding anything new, so your
records come back cleanly rather than mixing with new ones. To prevent it, [[install the
app|Installing-Gubbins]] and grant **persistent storage**.

> **ℹ️ Note**
> If a list couldn't be read this time — rather than being genuinely empty — Gubbins now says so
> in place with a short "couldn't be loaded" message and a **Try again** button, instead of looking
> empty. That usually clears on a retry; if it keeps happening, reload the app.

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
data corruption. Once Gubbins reaches 1.0, updates will preserve your data.

**Before you reset, press "Back up everything (.zip)" on that screen.** That builds an ordinary
Gubbins backup out of the database Gubbins couldn't open, and it is the copy you can bring back
afterwards: once the app starts again, restore it from the **Sync** screen → **Backup & restore**,
on the **Restore** tab, using **Merge**, which re-applies your records onto the new database
shape. The screen tells you what the backup captured, and names anything the old database
wouldn't give up.

> **⚠️ Heads-up**
> The other two downloads on that screen — the raw `.sqlite` copy and the JSON export — are for
> keeping or inspecting elsewhere (a SQLite browser, a text editor). Neither can be restored into
> Gubbins after a schema reset, because both are in the shape of the old database. Take the `.zip`.

> **💡 Tip**
> Take a [[backup|Backup-and-Restore]] regularly while Gubbins is pre-1.0, so a schema reset never
> costs you more than the changes since your last backup.

**What if the file I restore turns out to be broken?**
Gubbins checks a raw `.sqlite` database or `.zip` archive before restoring it — that it arrived
complete, and that the data inside is intact — so a half-finished download or a copy from a failing
drive is caught and explained rather than quietly replacing good data. If you want to go ahead with a
damaged file anyway, you can, after a second confirmation. And whichever you choose, a copy of your
current database is downloaded first, so you can always get back to where you started. See
[[Backup & restore|Backup-and-Restore]].

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
