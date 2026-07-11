# AI assistant query (MCP)

The [[bridge|Bridge-Overview]] can expose your inventory to an **AI assistant** through **MCP**
(the Model Context Protocol) — so a tool like an AI chat client can answer questions such as
*"where are my spare fuses?"* or *"how many ESP32s do I have?"* using your real data.

> **ℹ️ Note**
> This is a technical, opt-in feature for people who use MCP-capable AI tools. Setup steps and the
> exact tool list are in the bridge `README` in the
> [Gubbins repository](https://github.com/BootBlock/Gubbins).

## How it works

The bridge includes an **MCP server** that exposes your Gubbins data as a small set of
**read-only** tools — search items, get an item's details, and so on. You wire that server into an
MCP client, and the assistant can then look things up on your behalf, in natural language.

Because it uses the same query engine as the rest of the bridge, the assistant sees exactly the
data you'd see — and, by default, **cannot change anything**.

> **💡 Tip**
> The natural-language lookups here are the "external" cousin of the in-app
> [[plain-English search|Natural-Language-Search]] — same idea (ask a question, get your items),
> exposed to an outside assistant instead of the search box.

> **⚠️ Heads-up**
> An AI assistant wired to the bridge can read your inventory. Only connect assistants you trust,
> keep the bridge [[read-only|Running-the-Bridge]] unless you deliberately need writes, and protect
> the [[token|Running-the-Bridge]]. See [[Privacy & security|Privacy-and-Security]].

## Related pages

- **[[Bridge overview|Bridge-Overview]]** and **[[Running the bridge|Running-the-Bridge]]** — the
  foundation.
- **[[Home Assistant integration|Home-Assistant-Integration]]** — voice lookups in your smart home.
- **[[Natural-language search|Natural-Language-Search]]** — the same idea inside the app.
