# Running the bridge

The [[bridge|Bridge-Overview]] is a small server you run yourself, pointed at a copy of your
Gubbins data. This page is a friendly orientation — the authoritative, always-current setup steps
live in the bridge's own `README` in the [Gubbins repository](https://github.com/BootBlock/Gubbins).

> **ℹ️ Note**
> Running the bridge means running a command-line program (Node.js). It's aimed at people
> comfortable doing that; if that's not you, everything in the main app works without it.

## The essentials

To run the bridge you need three things:

1. **A copy of your data** — point the bridge at your [[sync snapshot|Cloud-Sync]]
   (`gubbins-sync.json`) or a raw `.sqlite` copy. It watches the file and re-reads it when it
   changes, so it stays current as you sync. If a re-read ever fails, it keeps answering from the
   last good copy rather than going dark — and tells you, as below.
2. **An [[API token|Bridge-API-Tokens]]** — mint one in the app under **Users → an account →
   API tokens**. Every request must present one, and it can only do what its owning account can
   do. There's nothing token-shaped to configure on the bridge itself: tokens travel with your
   data, so minting and revoking happen entirely in Gubbins.
3. **Start it** — run the read-only HTTP server. By default it binds **loopback only**
   (`127.0.0.1`), so it isn't reachable from other machines unless you deliberately change that.

Once it's up, you query it over HTTP with your token, or wire it into
[[Home Assistant|Home-Assistant-Integration]], an [[AI assistant|AI-Assistant-Query-MCP]], your
[[calendar|Webhooks-MQTT-and-iCal]], and more.

> **ℹ️ Note**
> A freshly started bridge refuses **every** request until it has read your data — that's where
> the tokens live, so until then it has no way to tell who is asking. It sorts itself out as soon
> as it picks up your [[snapshot|Cloud-Sync]]; if it doesn't, the file is the thing to check.

## Checking it's serving current data

The bridge has a **health check** at `/health`. As well as confirming it's up, it tells you
whether the data it's serving is still fresh:

- **`ok: true`** — the bridge is up *and* its copy of your data is current.
- **`ok: false`** — it's still answering, but its last few attempts to re-read your data failed,
  so what it's serving is out of date. The reply also says how many attempts failed, when the
  data was last read successfully, and what went wrong.

The usual cause is that the bridge can no longer see your snapshot file — the synced folder isn't
mounted, the file was moved or renamed, or permissions changed. The occasional single failure is
normal and self-corrects: the file is being rewritten as you sync, and the bridge may simply have
caught it mid-write.

> **💡 Tip**
> If you build a dashboard on the bridge, key it off `ok` rather than assuming the numbers are
> always current. That way a broken data feed shows as *unavailable* instead of quietly displaying
> yesterday's stock levels as if they were today's.

You don't have to poll `/health` separately to notice this. The same freshness verdict travels on
every other surface too, so whichever way you read the bridge you find out:

- **Every response** carries an `X-Gubbins-Snapshot-Stale: true` / `false` header, so an
  integration reading search results or the API learns the data is stale as it reads it.
- **Home Assistant over [[MQTT|Webhooks-MQTT-and-iCal]]** gets a dedicated *Snapshot stale* sensor —
  the entities stay put, but this one flips on so you can alert or automate on it.
- **The [[AI assistant tools|AI-Assistant-Query-MCP]]** add a short "this data may be out of date"
  note to their answers, so an assistant caveats a count rather than stating it as current.

## When something goes wrong while it's running

The bridge is built to **stay up**. An occasional problem — a hiccup reaching your MQTT broker, a
momentary shortage of system resources, a malformed request from something scanning your network —
is written to its log and then shrugged off. It keeps serving, so an integration that depends on it
doesn't quietly go dead.

If problems keep arriving in quick succession, the bridge takes the opposite view: something is
wrong that it can't recover from on its own, so it logs why and **stops**. Run it under something
that restarts it automatically — a Docker restart policy, a systemd service, or the Home Assistant
add-on — and it comes back on a clean slate without anyone noticing.

> **💡 Tip**
> If the bridge restarts repeatedly, its log holds the reason. The most common causes are a
> snapshot file it can no longer read and a broker or Home Assistant address it can never reach.

## Keeping it up to date

The bridge re-reads your **data** on its own, but it never updates **itself**. It runs from a copy
of the Gubbins repository you keep on your own machine, so it only moves forward when you update
that copy and restart it — pull the latest code and start it again, or rebuild the image if you run
it in [[Docker|Self-Hosting-with-Docker]].

Because of that, the bridge doesn't have a version of its own: it reports **the version of Gubbins
it was taken from**, which is the same number the app shows on its
[[About screen|About-and-Diagnostics]].

**Gubbins now checks this for you.** On the **Sync** screen, the bridge section compares the bridge
you're connected to against the app you're using and tells you when they've drifted apart:

- **Nothing shown** — the two match; there's nothing to do.
- **An update is available** — the bridge is a release or two behind. It's still reading your data
  correctly, so this is a nudge rather than a problem.
- **A warning** — the bridge is behind on the *data format*, not just the version. This is the one
  worth acting on: an older bridge can misread newer data and give answers that look plausible but
  aren't. Update it.
- **The bridge is newer** — usually just a browser tab that hasn't been reloaded since you updated.
  Refresh the app.
- **The bridge didn't say** — it's old enough to predate this check, so it's certainly due an update.

> **ℹ️ Note**
> There's no automatic updater and no download to verify — you always get whatever your copy of the
> repository contains. If you need to stay on a particular release, keep your copy on that release
> yourself.

## Read-only unless you say otherwise

The bridge **can't modify your inventory** by default — it's a window onto your data, not a way
in. Write-back is a separate, explicit opt-in, and even then it goes through Gubbins' safe merge so
it can't cause drift. It covers a short, fixed list: adjusting a quantity or a gauge,
[[checking an item out and back in|Loans-Check-Out-and-In]], and moving stock between
[[locations|Locations-and-Stock]]. Nothing can be renamed or deleted through it, and the only thing
it can create is a [[contact|Contacts]] — checking an item out to a name that doesn't match anyone
adds that person, exactly as doing it in the app would.

There are two gates, and both have to let a request through. Whoever runs the bridge decides which
capabilities exist at all; the caller's account then decides how much of that they may use. So
turning writes on doesn't hand write access to everyone holding a token — a read-only account
stays read-only.

If you also let the app **push** its data straight to the bridge (a separate opt-in, useful when
you don't use folder or Drive sync), a push is **merged** into the copy the bridge already holds
rather than replacing it wholesale. So a stock change an assistant made a moment earlier isn't
wiped out by a slightly-older push from a device that hadn't seen it — both survive, by the same
last-write-wins merge the rest of Gubbins uses.

> **⚠️ Heads-up**
> *Push* is a **separate** switch from write-back, but it isn't a milder one — it's **wider**.
> Write-back makes one bounded change from that short list; a push merges a whole dataset in, which
> can touch **any** part of your data. So turn push on with the same care as write-back, and hand its
> account only to a device you trust. As with everything here, the caller still needs the matching
> permission on its own account — turning the switch on doesn't give every token holder that reach.

> **⚠️ Heads-up**
> Keep an [[API token|Bridge-API-Tokens]] secret and out of any file you commit or share — this is
> a **public** project, and a leaked token plus an exposed bind would let others read your data.
> The safe default is loopback-only, with each integration on its own narrow account. See
> [[Privacy & security|Privacy-and-Security]].

## If you expose it beyond your own machine

By default the bridge listens on **loopback only** (`127.0.0.1`), so its traffic never leaves the
computer it runs on. You can bind it to your whole network instead (`GUBBINS_BRIDGE_HOST=0.0.0.0`)
to reach it from other devices — but it's worth knowing what that changes before you do.

The bridge speaks **plain HTTP — it has no HTTPS of its own**. On the loopback default that doesn't
matter, because nothing is on the wire. Once it's bound to the network, though, every request
travels **unencrypted**, and that includes your [[API token|Bridge-API-Tokens]] — both the one in
the request header and the `token=` some subscribe-by-URL feeds carry in the address itself. Anyone
able to watch that network could read it and reuse it for whatever the token's account is allowed to
do. The same is true of the token the bridge sends *to* [[Home Assistant|Home-Assistant-Integration]]
if you point it at an `http://` address.

> **⚠️ Heads-up**
> A wider bind is fine on a network you trust and control. To reach the bridge across one you
> **don't** — the wider internet, a shared or public network — put it behind something that adds
> **HTTPS** (a reverse proxy such as nginx or Caddy, or a secure tunnel) and keep the bridge itself
> on loopback behind it, and use an `https://` address for Home Assistant. Otherwise leave the
> default loopback bind in place. See [[Privacy & security|Privacy-and-Security]].

## Reaching it from a web browser

Some things talk to the bridge straight from a **web page** — most notably the app's *push to
bridge* button, which uploads your latest data to a running bridge. To keep a random web page you
happen to have open from quietly poking at a bridge on your network, the bridge only lets a browser
read its replies when the page comes from an address it recognises: the **official Gubbins app**
(`https://bootblock.github.io`) and anything on **your own machine** (a local dev copy). Everything
else a browser sends is turned away.

This is automatic and needs no setup for almost everyone. The one exception is if you **host the
Gubbins app yourself on your own web address** *and* use *push to bridge* — then tell the bridge to
trust that address by listing it in `GUBBINS_BRIDGE_ALLOWED_ORIGINS` (see the bridge's `README`).
The bridge prints which addresses it currently trusts when it starts up, and logs a one-line hint
if it turns a browser away, so a missing entry is easy to spot. None of this affects
[[Home Assistant|Home-Assistant-Integration]], an [[AI assistant|AI-Assistant-Query-MCP]], scripts
or other non-browser tools — that guard is a browser thing only.

## Related pages

- **[[Bridge overview|Bridge-Overview]]** — what the bridge is and its safety model.
- **[[Bridge API tokens|Bridge-API-Tokens]]** — minting, revoking and scoping access.
- **[[Home Assistant integration|Home-Assistant-Integration]]**,
  **[[AI assistant query (MCP)|AI-Assistant-Query-MCP]]**,
  **[[Webhooks]]**, **[[Webhooks, MQTT & iCal|Webhooks-MQTT-and-iCal]]** — what to do with it.
