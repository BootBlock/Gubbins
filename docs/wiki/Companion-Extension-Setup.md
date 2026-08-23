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

## Keeping it up to date

Gubbins updates itself; the extension does not. The app is served from the web and refreshes on
its own, while the extension is a folder you loaded into your browser by hand — so it only
changes when you rebuild it and reload it on your browser's extensions page. That means the two
can end up a version apart, with the extension knowing nothing about a feature the app has since
gained.

The two now tell each other which version of their shared language they speak, so the app can
work out what your extension can actually do:

- **Settings → Product lookup → Companion extension** names the extension it is connected to,
  with its version number. Quote that line if you ever report a problem with scraping or lookups.
- A feature the extension is too old to understand is **not offered**. A barcode lookup goes
  straight to the online database instead of waiting on an extension that would ignore it, and a
  **Scrape** control simply stays hidden rather than appearing and then doing nothing.
- If the extension is too old to work with at all, that same settings row says so and asks you
  to update it.

> **💡 Tip**
> After rebuilding the extension, open your browser's extensions page and press **Reload** on
> it, then reload the Gubbins tab. The version shown in Settings is how you confirm the new
> build is the one you are talking to.

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
