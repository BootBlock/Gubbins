# Bridge API tokens

An **API token** is the key a tool presents to the [[bridge|Bridge-Overview]] to prove who it is
acting as — and it can do exactly what that person can do, no more.

> **Where to find it:** in Gubbins, open **Users**, choose an account, and go to its
> **API tokens** section.

## What a token is

The bridge doesn't have a password of its own. Instead, every request carries a token you minted
against one **account**, and the bridge treats the request as coming *from that person*:

- It can read and change only what that account's role allows. A role that can't see suppliers in
  the app can't read them through the bridge either.
- Anything it changes is recorded in the [[activity log|Activity-Log]] against that account — so
  the history says who adjusted the stock, not just "something did".
- Access is granted and withdrawn entirely in Gubbins. Minting or revoking a token takes effect as
  soon as the change reaches the bridge's copy of your data — there is no config file to edit and
  nothing to restart.

> **ℹ️ Note**
> A token can only ever *narrow* what the bridge offers. Whoever runs the bridge decides which
> capabilities exist at all (writes, the event stream, Home Assistant reads, and so on); a token
> can't switch one on. If a feature is turned off there, no token reaches it.

## Minting one

1. Open **Users** and select the account the tool should act as.
2. Under **API tokens**, choose **New token** and give it a name that says what it's for —
   "Home Assistant", "Kitchen tablet dashboard". The name is only for you, so you can tell them
   apart later.
3. The token is shown **once**. Copy it straight into whatever will use it.

Tokens look like `gbn_` followed by a long random string. Gubbins keeps only a scrambled
fingerprint of it, plus the first few characters so you can recognise which is which in the list.

> **⚠️ Heads-up**
> The token is shown once and **cannot be recovered** — not by you, not by anyone. If you lose it,
> revoke it and mint a fresh one. Treat it exactly like a password: don't email it, paste it into
> a chat, or commit it to a repository.

## Revoking one

Delete the token from the same list. That's permanent: anything still presenting it is refused
from the moment the bridge sees the change. There is no "disable temporarily" — if you need access
back, create a new one.

> **ℹ️ Note** One exception is worth knowing about. If something has an **event stream** open
> (`/api/v1/events`) when you revoke its token, that already-open stream keeps running until the
> connection drops — every *new* request is refused straight away, but the bridge doesn't cut a
> live one mid-flight. Restart the thing that's listening if you need it stopped immediately.

Deleting a **user** takes their tokens with them, so an account you retire can't leave a working
key behind.

## Give each integration its own account

The most useful habit here is a small one: rather than pointing every tool at your own account,
create an account *for the tool* and give it a role holding only what it genuinely needs.

- A calendar subscription only needs to read bookings.
- A dashboard only needs to read items.
- A voice assistant that adjusts stock needs that, and nothing about suppliers, purchase orders
  or the audit trail.

The payoff is that a token which ends up somewhere it shouldn't — a shared config file, a
screenshot, a device you no longer own — is only ever worth the narrow slice you granted it. It
also makes the [[activity log|Activity-Log]] far more readable, because each integration's changes
are attributed to a name you chose.

> **💡 Tip**
> Subscribing a calendar app to the bridge's [[iCal feed|Webhooks-MQTT-and-iCal]] means putting the
> token in a URL, which is easier to leak than a request header. That's the strongest case of all
> for giving that subscription its own narrow account.

## When something is refused

Two different refusals mean two different things:

- **Not recognised** — the token is missing, mistyped, or has been revoked. Check what the tool is
  sending; mint a new one if it was revoked.
- **Not permitted** — the token is fine, but its owner's role doesn't cover what was asked for.
  Nothing is wrong with the credential; adjust the role (or use a different account) if the access
  is genuinely wanted.

There's also a third case that looks like a problem but isn't: a **freshly started bridge refuses
everything until it has read your data**, because that's where the tokens live. Give it a moment,
and make sure it can actually see your [[sync snapshot|Cloud-Sync]].

> **ℹ️ Note**
> An [[AI assistant connected over MCP|AI-Assistant-Query-MCP]] doesn't use a token at all — it
> runs as a local program on your own machine rather than over the network, so its trust boundary
> is the machine itself. Its changes are recorded against the system rather than a person.

## Related pages

- **[[Bridge overview|Bridge-Overview]]** — what the bridge is and its safety model.
- **[[Running the bridge|Running-the-Bridge]]** — starting it up and pointing it at your data.
- **[[Privacy & security|Privacy-and-Security]]** — the wider picture.
- **[[Home Assistant integration|Home-Assistant-Integration]]**,
  **[[Webhooks, MQTT & iCal|Webhooks-MQTT-and-iCal]]** — what you'll be handing a token to.
