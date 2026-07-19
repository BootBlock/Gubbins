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
2. **A secret token** — set a long, random token. Every request must present it, so only you (and
   the tools you configure) can query the bridge.
3. **Start it** — run the read-only HTTP server. By default it binds **loopback only**
   (`127.0.0.1`), so it isn't reachable from other machines unless you deliberately change that.

Once it's up, you query it over HTTP with your token, or wire it into
[[Home Assistant|Home-Assistant-Integration]], an [[AI assistant|AI-Assistant-Query-MCP]], your
[[calendar|Webhooks-MQTT-and-iCal]], and more.

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
in. Write-back (letting an assistant adjust stock, say) is a separate, explicit opt-in, and even
then it goes through Gubbins' safe merge so it can't cause drift.

> **⚠️ Heads-up**
> Keep the **token** secret and out of any file you commit or share — this is a **public**
> project, and a leaked token plus an exposed bind would let others read your data. The safe
> default is loopback-only with a strong token. See [[Privacy & security|Privacy-and-Security]].

## Related pages

- **[[Bridge overview|Bridge-Overview]]** — what the bridge is and its safety model.
- **[[Home Assistant integration|Home-Assistant-Integration]]**,
  **[[AI assistant query (MCP)|AI-Assistant-Query-MCP]]**,
  **[[Webhooks]]**, **[[Webhooks, MQTT & iCal|Webhooks-MQTT-and-iCal]]** — what to do with it.
