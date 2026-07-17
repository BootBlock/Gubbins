# Installing Gubbins

Gubbins runs in your web browser — there's nothing to download to *use* it. But **installing** it
as an app gives you a proper window, offline reliability, and features like
[[notifications|Reminder-Notifications]]. This page covers both.

## Just open it

Gubbins is a web app: open it in a modern browser and you're running. Because it's
[[local-first|How-Your-Data-Is-Stored]], your data stays on your device from the very first item.

### Supported browsers

Gubbins uses modern browser storage (OPFS) and needs a **cross-origin-isolated** context, which
current versions of major browsers provide. It's tested on Chromium-based browsers (Chrome, Edge)
and works across current mainstream browsers; some advanced features degrade gracefully where a
browser doesn't support them (for example, [[notifications|Reminder-Notifications]] are limited on
iOS).

> **ℹ️ Note**
> On your **first visit**, Gubbins may pause on a **“Preparing secure storage…”** screen for a
> moment while it sets up its private storage. That's normal, happens only once, and the page
> carries on by itself.

If Gubbins can't start, it says *why* on that screen rather than simply blaming your browser —
because usually the browser is fine and something else is withholding the storage it needs. The
common causes, all of which the screen names along with what to try:

- **The address isn't secure.** Gubbins needs `https://`, or a `localhost` address if you're
  running it yourself. A plain `http://` network address (like `http://192.168.1.10`) won't do.
- **Something is blocking its scripts** — a content blocker, privacy extension, antivirus, or a
  workplace or school network.
- **Site data is blocked** for the site. Gubbins keeps everything on your device, so “block all
  cookies” and the strictest tracking-protection modes leave it nowhere to store your inventory.
- **You're in a private or incognito window**, which restricts storage and background helpers.

Only once all of those are ruled out does Gubbins conclude the browser itself is the problem. The
screen also has a **Technical details** section worth including if you
[[report a problem|FAQ-and-Troubleshooting]].

## Install it as an app (recommended)

Gubbins is an **installable PWA**. Use your browser's *Install* option (often an icon in the
address bar, or a menu item) to add it to your device. Installed, Gubbins:

- Opens in its **own window**, like a native app.
- Shows an **offline indicator** and keeps working with no connection.
- Can send **[[reminder notifications|Reminder-Notifications]]**.
- Supports **[[kiosk / tablet mode|Kiosk-and-Tablet-Mode]]** with a screen wake-lock.

> **💡 Tip**
> After installing, grant **persistent storage** if your browser asks — it stops the browser from
> evicting your data when the device is low on space. See [[Storage triage|Storage-Triage]].

> **⚠️ Heads-up**
> Your inventory is stored by the browser for the site you installed from. Don't "clear site data"
> for Gubbins unless you mean to erase it, and keep a [[backup|Backup-and-Restore]]. Installing on
> a new device starts empty — bring your data with [[cloud sync|Cloud-Sync]] or a
> [[backup|Backup-and-Restore]].

## Staying up to date

As an installed app, Gubbins updates itself in the background and lets you know when a new version
is ready with a small banner, so you're always current without visiting a store. The new version
only takes over when **you** choose **Reload now** — nothing you're part-way through is lost by an
update arriving.

The banner tells you what the update means for your data before you reload:

- **"Your saved data stays intact"** — a normal update. Reloading keeps everything.
- **A reset warning** — while Gubbins is still pre-release (before 1.0), some updates change how
  data is stored and **can't carry your existing data across**. When that's the case the banner
  says so up front, so you can take a [[backup|Backup-and-Restore]] or
  [[export|Export-and-Import]] first if you want to keep it. See
  [[How your data is stored|How-Your-Data-Is-Stored]] for why this happens before 1.0.

If you're not ready to update, you have two choices on the banner:

- **Remind me later** — hides it for a while; it comes back so you don't forget.
- **Skip this version** — sits out this particular version for good. The banner stays away until an
  even newer version is released, then reappears so you can decide again.

> **⚠️ Heads-up**
> Skipping or postponing a reset-warning update doesn't remove the risk — it just delays it. Keep
> your own [[backups|Backup-and-Restore]] until Gubbins reaches 1.0, after which updates will always
> preserve your data.

## What next?

- **[[Quick start|First-Run-and-Quick-Start]]** — add your first item.
- **[[Core concepts|Core-Concepts]]** — the model behind the app.
- **[[Cloud sync|Cloud-Sync]]** — use Gubbins across devices.
