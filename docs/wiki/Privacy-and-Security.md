# Privacy & security

Gubbins is built around a simple promise: **your data is yours, and it stays on your device**.
This page explains what that means in practice.

## Private by default

- **No account, no server.** Gubbins has no sign-up and no backend. Your inventory lives in your
  browser's storage on your device — see [[How your data is stored|How-Your-Data-Is-Stored]].
- **Nothing is uploaded unless you choose it.** The app never phones home. Data only moves when
  *you* enable a feature and point it at storage or a service *you* control.
- **Fully offline.** Because nothing depends on a server, Gubbins keeps working with no connection
  at all.

## The features that *can* move data — and how they're contained

A few optional features exist precisely to move data. Each is opt-in and stays under your control:

| Feature | What it does | Your control |
| --- | --- | --- |
| **[[Cloud sync\|Cloud-Sync]]** | Keeps devices in step | Through *your own* folder or Drive; no Gubbins server in between |
| **[[Backup & restore\|Backup-and-Restore]]** | Portable copy of your data | A file *you* save, where *you* choose |
| **[[Export & import\|Export-and-Import]]** | Open-format data out/in | Only what you export leaves |
| **[[Bridge\|Bridge-Overview]]** | Exposes data to other tools | You run it; loopback-only by default, and every caller presents an [[API token\|Bridge-API-Tokens]] that can only do what its owning account can; read-only unless you allow writes |
| **[[Webhooks]]** (delivered by the bridge) | Calls a URL you chose when something changes | Off until you add one; goes only where you point it. Sign it so your receiver can confirm it's genuine — and prefer a secret held by the bridge, since one stored on the webhook travels with your synced data |
| **[[MQTT publishing\|Webhooks-MQTT-and-iCal]]** (part of the bridge) | Pushes stock counts and per-location details to your broker | Off until you enable it; goes to *your* broker. Note this one **pushes** rather than waiting to be asked — including every [[custom field\|Custom-Fields-and-Capabilities]] on a location |
| **[[Scraping\|Scraping-Supplier-Data]]** | Reads a supplier web page | Only when *you* trigger it, via the trusted companion extension |
| **[[Product lookup\|Scraping-Supplier-Data]]** | Names a scanned barcode | Off until you allow it; then sends *only the barcode number* to Open Food Facts, only when you tap **Look up** |
| **[[Camera scanning\|Camera-Scanning]]** / **[[OCR\|Receipt-and-Label-OCR]]** | Read codes / text | On-device only; no image leaves your device |
| **[[Diagnostics\|About-and-Diagnostics]]** | Environment details for a bug report | Only gathered when you press **Refresh**; only shared if you copy it or open the pre-filled issue; never includes your inventory |

## Good habits

> **💡 Tip**
> - Keep a **[[backup|Backup-and-Restore]]** — local-first means *you* hold the only copy.
> - [[Install|Installing-Gubbins]] the app and grant **persistent storage** so the browser won't
>   evict your data.
> - If you run the **[[bridge|Running-the-Bridge]]**, treat its
>   [[API tokens|Bridge-API-Tokens]] like passwords, give each integration its own account with a
>   narrow role, keep the default loopback bind, and leave write-back off unless you need it.

> **⚠️ Heads-up**
> The flip side of local-first is that **you** are responsible for your data's safety. There's no
> cloud to recover it from if you clear your browser storage without a backup. A little routine —
> sync plus the odd backup — keeps it safe.

## For the technically curious

Gubbins uses a strict content-security policy and keeps its network surface tiny by design. The
project is **open source** (MIT-licensed) and **public**, so anyone can inspect exactly what it
does — see the [Gubbins repository](https://github.com/BootBlock/Gubbins).

## Related pages

- **[[How your data is stored|How-Your-Data-Is-Stored]]** — the local-first model.
- **[[Backup & restore|Backup-and-Restore]]** and **[[Cloud sync|Cloud-Sync]]** — keeping data safe
  and portable.
- **[[Bridge overview|Bridge-Overview]]** — the security model for the one networked feature.
- **[[About & diagnostics|About-and-Diagnostics]]** — exactly what a bug report includes.
