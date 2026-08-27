# AI assistant query (MCP)

The [[bridge|Bridge-Overview]] can expose your inventory to an **AI assistant** through **MCP**
(the Model Context Protocol) — so a tool like an AI chat client can answer questions such as
*"where are my spare fuses?"* or *"how many ESP32s do I have?"* using your real data.

> **ℹ️ Note**
> This is a technical, opt-in feature for people who use MCP-capable AI tools. Setup steps and the
> exact tool list are in the bridge `README` in the
> [Gubbins repository](https://github.com/BootBlock/Gubbins).

## How it works

The bridge includes an **MCP server** that exposes your Gubbins data as a small set of tools —
search items, get an item's details, and so on. These are **read-only**: you wire that server into
an MCP client, and the assistant can then look things up on your behalf, in natural language.

Because it uses the same query engine as the rest of the bridge, the assistant sees exactly the
data you'd see — and, by default, **cannot change anything**.

> **ℹ️ Note — protocol versions**
> MCP is revised from time to time, and a client says which revision it wants when it connects. The
> bridge agrees only to a revision it actually implements; if your client asks for a newer one, the
> bridge replies with the newest it supports and the client decides whether to carry on. So a
> mismatch is settled when you connect, rather than showing up later as tools that half-work.

> **ℹ️ Note — the assistant is told when the data may be out of date**
> If the bridge can no longer re-read your data it keeps answering from the last copy it had (so the
> assistant isn't left with nothing), but those figures are then stale. When that happens, its
> answers come with a short note that the data may be out of date and when it was last refreshed —
> so the assistant can say "you had 12 as of this morning" rather than stating a stale number as if
> it were current. This matches the freshness signal the rest of the bridge gives; see
> [[checking it's serving current data|Running-the-Bridge]].

## Letting an assistant change things (optional)

If you switch **writes** on when running the bridge, a few more tools appear alongside the
read-only ones, letting an assistant *change* your inventory as well as look it up — so "I've just
used two of those" can actually bring the count down, and "Sam's borrowed the multimeter" can
actually put it out on loan:

- **Adjust a quantity** — add or remove a whole number of a counted item.
- **Adjust a gauge** — change how full a part-used item is (a solder reel, a bottle of flux).
- **Check an item out** — [[lend it|Loans-Check-Out-and-In]] to a person, a project or a place
  such as a van, optionally with a due date.
- **Check an item in** — take a loan back, returning the stock to exactly where it came from.
- **Move stock between locations** — shift some of an item from one place to another without
  changing how much of it you have.

Nothing else is exposed: an assistant cannot rename or delete anything, and the only thing it can
create is a [[contact|Contacts]] — lending to a name that doesn't match anyone adds that person,
exactly as doing it in the app would. Every change is recorded in the
[[activity log|Activity-Log]] just as if you'd made it yourself, so you can always see what
happened, and the changes flow back through the same [[sync|Cloud-Sync]] as any other, so your other
devices pick them up normally.

An assistant connection and the bridge's web API can run side by side over the same data, and your
devices may be syncing to that file at the same time. Each change checks the file is still the one
it read before saving, so an assistant's adjustment can't quietly wipe out one made a moment
earlier somewhere else. If it keeps losing that race the assistant is told your data kept changing,
or was busy, and to try again — nothing was changed, so asking again is safe.

> **⚠️ Heads-up**
> This is off by default, and worth a moment's thought before switching on. Unlike the bridge's
> web API — where every caller presents an [[API token|Bridge-API-Tokens]] and is held to that
> account's permissions — an MCP assistant presents nothing at all: anything able to start the
> server with writes enabled can adjust your stock and lend your things out, and the change is
> recorded against the system rather than a person. Turn it on only for an assistant you trust on a
> machine you control, and bear in mind that an assistant can be influenced by whatever it reads.
> Ask it to confirm before it changes anything.

> **💡 Tip**
> The natural-language lookups here are the "external" cousin of the in-app
> [[plain-English search|Natural-Language-Search]] — same idea (ask a question, get your items),
> exposed to an outside assistant instead of the search box.

> **⚠️ Heads-up**
> An AI assistant wired to the bridge can read your inventory. Only connect assistants you trust,
> keep the bridge [[read-only|Running-the-Bridge]] unless you deliberately need writes, and protect
> your [[API tokens|Bridge-API-Tokens]]. See [[Privacy & security|Privacy-and-Security]].

## Related pages

- **[[Bridge overview|Bridge-Overview]]** and **[[Running the bridge|Running-the-Bridge]]** — the
  foundation.
- **[[Home Assistant integration|Home-Assistant-Integration]]** — voice lookups in your smart home.
- **[[Natural-language search|Natural-Language-Search]]** — the same idea inside the app.
