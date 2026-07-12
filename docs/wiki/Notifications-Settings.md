# Notifications settings

Gubbins' **Notifications & files** settings control how it gets your attention — OS reminder
notifications — and how it handles file attachments.

**Where to find it:** **Settings → Notifications & files**.

## Reminder notifications

On an [[installed|Installing-Gubbins]] app, Gubbins can raise your [[alerts|Alerts]] as OS
notifications. Here you turn them on (granting your device's permission) and choose which lanes to
receive — **low stock**, **expiring**, **maintenance due**, **warranty due**. The full behaviour
is covered on the [[Reminder notifications|Reminder-Notifications]] page.

You can also set how in-app confirmations behave — for example, whether an action shows a **toast**
or stays **silent**.

## Online product lookup

**Online product lookup** controls whether a barcode [[product lookup|Scraping-Supplier-Data]] may
reach the internet **directly** — querying the open Open Food Facts database — when the
[[companion extension|Companion-Extension-Setup]] isn't installed.

It's **off** until you allow it (you're asked once, the first time you look a barcode up). When on,
a lookup sends **only the barcode number** to `openfoodfacts.org`, and only when you tap **Look
up** — never automatically. Turn it off to keep every lookup offline; you can still fill product
details in by hand.

## Attachments & files

This is also where you decide what kind of **[[attachments|Tags-Attachments-and-Related-Items]]**
items may hold:

- **External URLs only** — links to files hosted elsewhere.
- **URLs and local file pointers** — also allow pointers to files on this device.

> **ℹ️ Note**
> A **local file pointer** references a file on *this* device — so it may not resolve on another
> device you sync to. For attachments you want to travel with your data, prefer a URL or rely on
> the [[export vault|Export-and-Import]], which can bundle full-resolution images.

> **💡 Tip**
> Keep notifications to the lanes you actually act on — a focused stream you respond to beats a
> noisy one you learn to ignore.

## Related pages

- **[[Reminder notifications|Reminder-Notifications]]** — how OS reminders work.
- **[[Tags, attachments & related items|Tags-Attachments-and-Related-Items]]** — the attachments
  these settings govern.
- **[[Alerts]]** — the source of the reminders.
