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
