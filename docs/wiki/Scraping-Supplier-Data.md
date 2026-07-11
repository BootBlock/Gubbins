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
