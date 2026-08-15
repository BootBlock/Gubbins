/**
 * The bridge's own stable, address-independent identity (issue #672).
 *
 * Consumers used to have nothing to recognise a bridge by except where it answered — the Home
 * Assistant integration keyed its config entry on `host:port`. The moment the bridge's host picked
 * up a different DHCP lease, that consumer no longer recognised the *same* bridge: the old entry
 * retried a dead address forever while mDNS offered the bridge as something brand new. An address
 * is a location, not an identity, so this module gives the bridge one of its own — reported by
 * `GET /health` and advertised in the mDNS TXT record, so both the manual and the discovered path
 * see the same value.
 *
 * The id is **not a secret**: it identifies which bridge you are talking to, it authorises nothing,
 * and it rides in an unauthenticated mDNS advertisement by design. Nothing about the served
 * inventory is derivable from it.
 *
 * Resolving it walks four steps, in order, and the order is the whole design:
 *
 * 1. **`GUBBINS_BRIDGE_ID`** — an operator-pinned value always wins. It is what carries an identity
 *    across a move to different hardware, and what a container can be given instead of a volume.
 * 2. **The persisted file** — the ordinary case. Read it and the identity survives restarts,
 *    upgrades and address changes with no configuration at all.
 * 3. **A freshly minted random id**, written to that file. This is a bridge's first start.
 * 4. **A value derived from the hostname and port** — only when the mint could not be persisted
 *    (a read-only filesystem, no write permission). It is the *fallback*, not the default, because
 *    it moves with the machine; but it is stable across restarts, which is the property that
 *    matters. A random id we could not persist must **never** be used: it would change on every
 *    restart and a consumer keying on it would duplicate its device each time — worse than the
 *    address keying this replaces.
 *
 * Everything here is **pure**: the four effects it needs (read the file, write it, mint, ask the
 * host its name) arrive as an injected {@link BridgeIdIo}, so every branch — including the one that
 * must never happen — is unit-testable. The `node:fs` / `node:crypto` shell that supplies them is
 * the composition root's job, alongside the rest of the impure wiring (see `serve.ts`).
 */

/** Default filename for the persisted id, resolved relative to the bridge's working directory. */
export const DEFAULT_BRIDGE_ID_FILE = 'bridge-id';

/**
 * Longest accepted bridge id. It travels in a DNS-SD TXT entry (255 bytes for the whole
 * `key=value` string) and in a Home Assistant unique id, so it is kept comfortably short — a
 * UUID is 36 characters.
 */
export const MAX_BRIDGE_ID_LENGTH = 64;

/**
 * The characters a bridge id may contain. Deliberately narrow: it is embedded in a TXT record and
 * used as an identifier by consumers, so it stays plain ASCII with no whitespace, no `=` (which
 * would split a TXT entry) and nothing needing escaping anywhere it lands.
 */
const BRIDGE_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

/**
 * Accept a candidate bridge id, or `undefined` when it is blank or malformed.
 *
 * Lenient on purpose: it is used both on the operator's `GUBBINS_BRIDGE_ID` (whose caller turns a
 * rejection into a loud startup error) and on the contents of the persisted file (where a
 * truncated or hand-mangled value should simply be replaced by a fresh mint rather than taking
 * the bridge down).
 */
export function parseBridgeId(raw: string | undefined): string | undefined {
  const trimmed = (raw ?? '').trim();
  if (trimmed.length === 0 || trimmed.length > MAX_BRIDGE_ID_LENGTH) return undefined;
  return BRIDGE_ID_PATTERN.test(trimmed) ? trimmed : undefined;
}

/**
 * The last-resort identity: derived from the host's name and the port it serves on.
 *
 * Both parts survive a DHCP lease change — which is the failure this whole module exists for —
 * and both are already visible on the wire in the mDNS advertisement, so this discloses nothing
 * new. The port is included so two bridges on one machine stay distinguishable.
 */
export function deriveBridgeId(hostname: string, port: number): string {
  const label = hostname
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    // Trimmed *after* the cap, so truncating mid-name cannot leave a dangling separator.
    .slice(0, 40)
    .replace(/^-+|-+$/g, '');
  return `${label.length > 0 ? label : 'gubbins-bridge'}-${port}`;
}

/** The effects {@link resolveBridgeId} needs, injected so the resolution order is testable. */
export interface BridgeIdIo {
  /** The persisted id, or `undefined` when there is no readable, valid one. */
  readPersisted(): string | undefined;
  /** Persist a freshly minted id. Returns whether it was actually written. */
  persist(id: string): boolean;
  /** Mint a fresh random id. */
  mint(): string;
  /** The host's name, for the derived fallback. */
  hostname(): string;
  /** Report a condition the operator should know about (an unpersistable id). */
  warn(message: string): void;
}

/** How a resolved id was arrived at — reported at startup so the operator can see which. */
export type BridgeIdSource = 'configured' | 'persisted' | 'minted' | 'derived';

/** A resolved identity, and which of the four steps produced it. */
export interface ResolvedBridgeId {
  readonly id: string;
  readonly source: BridgeIdSource;
}

/**
 * Resolve the bridge's identity — see this module's header for the four steps and why they are in
 * that order. `explicit` is the already-validated `GUBBINS_BRIDGE_ID`.
 */
export function resolveBridgeId(
  explicit: string | undefined,
  port: number,
  io: BridgeIdIo,
): ResolvedBridgeId {
  if (explicit !== undefined) return { id: explicit, source: 'configured' };

  const persisted = io.readPersisted();
  if (persisted !== undefined) return { id: persisted, source: 'persisted' };

  const minted = io.mint();
  if (io.persist(minted)) return { id: minted, source: 'minted' };

  const derived = deriveBridgeId(io.hostname(), port);
  io.warn(
    `Could not save this bridge's identity, so it is derived from the machine name instead ` +
      `("${derived}"). It will change if the machine is renamed or the bridge moves — set ` +
      `GUBBINS_BRIDGE_ID to pin it, or make the id file writable (GUBBINS_BRIDGE_ID_FILE).`,
  );
  return { id: derived, source: 'derived' };
}
