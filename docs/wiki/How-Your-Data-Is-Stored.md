# How your data is stored

Gubbins is **local-first**: your entire inventory lives in a database **inside your browser, on
your own device**. There's no account, no server, and nothing is uploaded anywhere unless you
explicitly choose to. Understanding this explains a lot about how the app behaves.

## Where the data lives

Gubbins keeps your data in an in-browser **SQLite database** (running as WebAssembly, stored in
your browser's private **OPFS** storage). That database is the **single source of truth** — every
item, location, loan and report reads from it. Exactly which of the two OPFS storage engines holds
it depends on what your browser offers — see [[Installing Gubbins|Installing-Gubbins]] — but it is
one database either way, and everything below applies to both.

Because it's all local:

- **It works fully offline.** No connection is ever required to use Gubbins.
- **It's fast.** Queries run on your device, not over a network.
- **It's private.** Your inventory doesn't exist on anyone else's computer. See
  [[Privacy & security|Privacy-and-Security]].

> **ℹ️ Note**
> The database is stored **unencrypted**. That's what makes it portable and recoverable — you can
> [[export the raw file|Export-and-Import]] and open it with any SQLite tool. It also means that
> turning on [[sign-in|Signing-In]] guards the *app*, not the file: anyone with access to this
> device's files can read your inventory regardless. If the data itself needs protecting, that's a
> job for your device's passcode and disk encryption.

> **⚠️ Heads-up**
> Because the data is stored *by your browser*, clearing your browser's site data for Gubbins —
> or an aggressive "free up space" cleanup — can remove it. Keep a **[[backup|Backup-and-Restore]]**,
> and [[install the app|Installing-Gubbins]] and grant *persistent storage* so the browser won't
> evict it.

## If your data disappears

Because the database belongs to your browser, the browser can remove it — and it doesn't ask
first. That happens when storage is reclaimed under pressure, when a device goes a long stretch
without opening Gubbins (iOS clears storage for web apps after **seven days** unless they're
[[installed|Installing-Gubbins]]), or when a "clear browsing data" sweep includes site storage.

Your *settings* live separately, so an empty Gubbins can otherwise look exactly like a brand-new
one — your theme, your dashboard, past the first-run wizard, and nothing in it. To stop that
passing unnoticed, Gubbins remembers on each device that it has held a database before. If it ever
starts and finds it has to create a new one, it says so before letting you in:

> **Your Gubbins data is gone** — Gubbins has run on this device before, but the database it kept
> here is no longer there.

The screen tells you when this device last opened Gubbins and roughly how much it held, and offers
to **restore a backup** — either a full `.zip` archive or a raw `.sqlite` file — straight away. You
can also **continue with an empty inventory**; the notice reappears on the next start until you do
one or the other, so it can't be lost by closing the tab.

> **⚠️ Heads-up**
> If you have a backup, restore it **before** adding anything. Restoring into an inventory you've
> started re-typing merges the two, which is far messier to untangle than a clean restore.

> **ℹ️ Note**
> This can only be reported when *something* survived to report it. A browser clear-out that
> removes everything for the site — settings included — takes that record with it, and Gubbins
> then genuinely cannot tell your device apart from a new one, so it starts as a first run. That
> is another reason to keep a [[backup|Backup-and-Restore]] or [[cloud sync|Cloud-Sync]] rather
> than relying on any single device.

## Getting data in and out

Local-first doesn't mean locked-in. You can move your data freely:

- **[[Cloud sync|Cloud-Sync]]** — keep devices in step via *your own* storage.
- **[[Backup & restore|Backup-and-Restore]]** — a single portable file of everything.
- **[[Export & import|Export-and-Import]]** — open formats (Markdown, CSV, raw SQLite).
- The optional **[[bridge|Bridge-Overview]]** — read your data from other tools.

> **💡 Tip**
> A good habit: [[install|Installing-Gubbins]] Gubbins, turn on [[cloud sync|Cloud-Sync]] to your
> own folder or drive, and take an occasional [[backup|Backup-and-Restore]]. That's belt and
> braces — your data is safe and portable, and still never leaves your control.

## Related pages

- **[[Cloud sync|Cloud-Sync]]**, **[[Backup & restore|Backup-and-Restore]]**,
  **[[Export & import|Export-and-Import]]** — the ways data travels.
- **[[Storage triage|Storage-Triage]]** — managing space.
- **[[Privacy & security|Privacy-and-Security]]** — the privacy guarantees in full.
