# Scraping supplier data

With the [[companion extension|Companion-Extension-Setup]] installed, Gubbins can **read a supplier
or retailer page** and fill an item's details from it — part number, manufacturer, parameters,
price, datasheet — so you don't retype what's already on screen.

**Where to find it:** the **Scrape** controls on an item, unlocked once the extension is connected.

## What it can pull

Open a product page for a part and scrape it. Gubbins has purpose-built parsers for major
electronics suppliers and retailers, plus a generic fallback for other sites:

- **DigiKey, Mouser, Farnell, LCSC, RS, Adafruit, SparkFun, Amazon** — dedicated parsers.
- **Any other site** — a generic metadata fallback that grabs what it can.

It can also do a **barcode → product lookup** and a **one-click price refresh** to update what a
part currently costs.

## Barcode → product lookup (works without the extension)

When you add or edit an item, a **Look up product** panel appears next to a filled‑in **Barcode**.
It fetches the product's **name and brand** from the open, free **Open Food Facts** database and
fills any empty fields — handy on a phone where you've just scanned a grocery barcode.

- **With the [[companion extension|Companion-Extension-Setup]]** installed, the extension does the
  lookup for you.
- **Without it** (for example on a phone), Gubbins can look the barcode up **online itself**. The
  first time, it asks for your permission and explains that it will send *only the barcode number*
  to `openfoodfacts.org` — nothing else about your inventory. It only ever does this when you tap
  **Look up**, never automatically.

You can change your mind any time under **[[Settings → Scanning & labels|Camera-Scanning]] → Product
lookup → Online product lookup** — turn it off to keep every lookup offline.

> **ℹ️ Note**
> Open Food Facts covers groceries and consumables, so a hardware or electronics barcode often has
> no match — that's a simple "not found", not an error.

## Reviewable, never destructive

Scraped data is applied carefully:

- It **fills empty fields** and doesn't overwrite something you've already edited — so your own
  corrections are safe.
- You review what came in before it's kept.

> **💡 Tip**
> Scrape when you *first add* a part — you get its datasheet link, MPN and parameters in one step —
> then use the **price refresh** later to keep costs current without re-entering anything.

> **ℹ️ Note**
> If a page can't be read — a login wall, a CAPTCHA, or an unsupported layout — Gubbins tells you
> with a clear reason rather than failing silently. A groceries barcode with no match is a simple
> "not found", not an error.

## Related pages

- **[[Companion extension setup|Companion-Extension-Setup]]** — installing and connecting it.
- **[[Supplier parts & price history|Supplier-Parts-and-Price-History]]** — where prices are kept.
- **[[Camera scanning|Camera-Scanning]]** and **[[Receipt & label OCR|Receipt-and-Label-OCR]]** —
  other ways to capture item details.
