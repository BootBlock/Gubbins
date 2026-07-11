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
is ready, so you're always current without visiting a store.

## What next?

- **[[Quick start|First-Run-and-Quick-Start]]** — add your first item.
- **[[Core concepts|Core-Concepts]]** — the model behind the app.
- **[[Cloud sync|Cloud-Sync]]** — use Gubbins across devices.
