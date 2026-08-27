# Self-hosting with Docker

Gubbins can be served from your own machine or home server using the Docker image in the project
repository, instead of using the hosted site.

**Where to find it:** the `Dockerfile` and `docker-compose.yml` in the
[Gubbins repository](https://github.com/BootBlock/Gubbins).

## What self-hosting does and doesn't change

This is worth being clear about up front, because it's easy to expect more than it gives.

Gubbins is a **[[local-first|How-Your-Data-Is-Stored]]** app: it runs in your browser, and your
inventory lives in that browser's private storage. Self-hosting changes **where the app is served
from** — not where your data lives. The container holds no inventory at all.

> **⚠️ Heads-up**
> Self-hosting does **not** give you more storage space. Your data is still kept in your browser's
> storage and is still subject to the same limits, so [[storage triage|Storage-Triage]] applies
> exactly as it does on the hosted site. It also doesn't change how photos are compressed, and it
> doesn't store attachment files — [[attachments|Tags-Attachments-and-Related-Items]] remain links
> and file paths rather than copies.

What you *do* get:

- **A more robust setup for the in-browser database.** Gubbins runs on either of two storage
  engines (see [[Installing Gubbins|Installing-Gubbins]]), and the faster one needs a browser
  feature called cross-origin isolation. The hosted site has to enable that indirectly, through a
  workaround; a self-hosted server enables it directly and properly.
- **Your own address.** Serve Gubbins from your own domain or LAN, at the root of the site or under
  a sub-path of your choosing.
- **No dependency on the hosted site** — useful on an isolated or offline network.

## Running it

You need [Docker](https://docs.docker.com/get-started/) and a copy of the repository. From the
repository folder:

```bash
docker compose up -d
```

Then open **<http://localhost:8080/>**.

> **⚠️ Heads-up**
> The optional [[companion extension|Companion-Extension-Setup]] does not recognise a
> self-hosted copy, so its **Scrape** controls stay hidden here. It is pinned to the addresses
> Gubbins is published at, and adding yours means rebuilding it from the repository with that
> address listed. Everything else works exactly as on the hosted app.

To stop it again:

```bash
docker compose down
```

If you'd rather not use Compose, you can build and run the image directly:

```bash
docker build -t gubbins .
docker run --rm -p 8080:8080 gubbins
```

### Serving it under a sub-path

By default the app is served from the root of its address. To serve it from, say,
`https://home.example.com/gubbins/` instead, build it with that path:

```bash
docker build --build-arg GUBBINS_BASE_PATH=/gubbins/ -t gubbins .
```

> **ℹ️ Note**
> The path is fixed when the image is **built**, not when it starts, because it's baked into the
> app's internal links. Changing it means rebuilding the image.

> **⚠️ Heads-up**
> The path is also what an [[installed|Installing-Gubbins]] copy is identified by. If you rebuild
> under a different path, install it again from the new address — an already-installed copy still
> points at the old one, and your browser treats the two as separate apps.

### Reaching it from other devices

The default setup listens on `localhost` only. To reach Gubbins from a phone or another computer
on your network, you'll need to publish the port more widely — and to serve it over **HTTPS**.

> **⚠️ Heads-up**
> Gubbins' storage needs a secure context. That means `https://`, or a `localhost` address. A plain
> `http://192.168.1.10`-style address **will not work**, no matter how the container is configured.
> Put a reverse proxy with a certificate in front of the container for LAN access. This is the same
> requirement described under [[Installing Gubbins|Installing-Gubbins]].

## Running the bridge alongside it

The optional [[bridge|Bridge-Overview]] — which lets Home Assistant, scripts and AI assistants ask
about your inventory — can run in the same Compose setup. It's off unless you ask for it:

```bash
docker compose --profile bridge up -d
```

The bridge needs a copy of your synced data, and each tool that queries it needs an
[[API token|Bridge-API-Tokens]] minted in the app — there's no token to set on the container. See
[[Running the bridge|Running-the-Bridge]] for what to set and why, and
[[Cloud sync|Cloud-Sync]] for producing the synced file it reads.

## Keeping your data safe

Because your inventory lives in your browser and not in the container, rebuilding, updating or
deleting the container **cannot** lose your data — but clearing your browser's site data still
can. Self-hosting doesn't change that, so [[Backup & restore|Backup-and-Restore]] matters exactly
as much as before.

## See also

- [[Installing Gubbins|Installing-Gubbins]] — installing the app itself, hosted or self-hosted
- [[How your data is stored|How-Your-Data-Is-Stored]] — what local-first means in practice
- [[Storage triage|Storage-Triage]] — what happens as storage fills up
- [[Bridge overview|Bridge-Overview]] — the optional companion service
- [[Privacy & security|Privacy-and-Security]]
