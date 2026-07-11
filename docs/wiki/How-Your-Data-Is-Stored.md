# How your data is stored

Gubbins is **local-first**: your entire inventory lives in a database **inside your browser, on
your own device**. There's no account, no server, and nothing is uploaded anywhere unless you
explicitly choose to. Understanding this explains a lot about how the app behaves.

## Where the data lives

Gubbins keeps your data in an in-browser **SQLite database** (running as WebAssembly, stored in
your browser's private **OPFS** storage). That database is the **single source of truth** — every
item, location, loan and report reads from it.

Because it's all local:

- **It works fully offline.** No connection is ever required to use Gubbins.
- **It's fast.** Queries run on your device, not over a network.
- **It's private.** Your inventory doesn't exist on anyone else's computer. See
  [[Privacy & security|Privacy-and-Security]].

> **⚠️ Heads-up**
> Because the data is stored *by your browser*, clearing your browser's site data for Gubbins —
> or an aggressive "free up space" cleanup — can remove it. Keep a **[[backup|Backup-and-Restore]]**,
> and [[install the app|Installing-Gubbins]] and grant *persistent storage* so the browser won't
> evict it.

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
