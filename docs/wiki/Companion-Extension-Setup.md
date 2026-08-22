# Companion extension setup

Gubbins has an optional **companion browser extension** that lets it pull product and supplier
details from web pages — datasheets, parameters, prices — straight into your items. This page
covers what it is and how it connects.

**Where to find it:** the **Product & supplier lookup** capability in [[Modular UI|Modular-UI]]
enables the in-app side; the extension installs into your browser separately.

## Why an extension?

A web page's content is only accessible to code running *in that page's tab*. The companion
extension is what reads a supplier or retailer page so Gubbins can use it — the app itself never
reaches out to those sites. The extension and the app talk to each other locally, in your
browser.

## Connecting it

Once the extension is installed and the **Product & supplier lookup** capability is on, the two
recognise each other and Gubbins unlocks its **Scrape** controls. Until the extension is present,
those controls stay hidden — nothing to configure and nothing running in the background.

> **ℹ️ Note**
> The connection is strictly local and origin-checked: Gubbins only accepts data from the trusted
> companion extension, and messages from any other source are silently ignored. See
> [[Privacy & security|Privacy-and-Security]].

> **⚠️ Heads-up**
> This is the one feature that reaches out to the web, and only when *you* trigger it on a page.
> The rest of Gubbins stays fully [[offline and local|How-Your-Data-Is-Stored]].

## Where it works

The extension talks to Gubbins itself and nowhere else — the hosted app at
`https://bootblock.github.io/Gubbins/`, or a development copy on your own machine at
`http://localhost:5173/Gubbins/`. It is not present on any other page you browse: it reads
nothing there and cannot be asked to do anything. The one exception is the Amazon listing page
you point it at yourself, which it reads only for as long as it takes to answer the toolbar
button or the **Add to Gubbins** menu item you clicked — see
[[Scraping supplier data|Scraping-Supplier-Data]].

> **ℹ️ Note**
> If you [[host Gubbins yourself|Self-Hosting-with-Docker]] — including the Docker image on
> `http://localhost:8080/` — the extension does not recognise your copy, and its **Scrape**
> controls stay hidden. Adding your address means rebuilding the extension from the repository
> with that address listed, not editing the extension folder in place; `extension/README.md`
> gives the two-line recipe. The list is deliberately narrow rather than a wildcard, because a
> wildcard broad enough to cover your address would also cover every unrelated site sharing it.

## Related pages

- **[[Scraping supplier data|Scraping-Supplier-Data]]** — using it to fill item details.
- **[[Supplier parts & price history|Supplier-Parts-and-Price-History]]** — where scraped prices
  land.
- **[[Modular UI|Modular-UI]]** — enabling the capability.
