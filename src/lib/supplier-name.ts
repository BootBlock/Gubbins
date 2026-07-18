/**
 * Supplier-name canonicalisation — the single home of "what counts as the same supplier".
 *
 * Suppliers are a first-class entity keyed by a case-insensitively unique name, but the
 * database only folds *case*. The variants that actually cause duplicates in practice differ
 * by spacing or punctuation instead — `RS Components`, `RS  Components`, `RS-Components` all
 * read identically on screen but are three distinct strings. Keeping both rules here means
 * every write, lookup and merge path folds them the same way; kept pure and dependency-free
 * so the rules are unit-testable and can never drift between call sites.
 */

/**
 * The stored, user-visible form: trimmed with internal whitespace collapsed to single
 * spaces. Casing and punctuation are the user's — `RS-Components` is preserved verbatim,
 * because this is what gets shown back to them.
 */
export function normaliseSupplierName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

/**
 * The identity key two names are compared on: case-folded, diacritics stripped, and every
 * character that is not a letter or digit dropped — so spacing, hyphens, dots and ampersands
 * stop mattering and `Müller` matches `Muller`. This is deliberately more aggressive than
 * {@link normaliseSupplierName}: it decides whether a typed name *resolves to an existing
 * supplier*, not what gets stored.
 *
 * Letters are matched by Unicode property, not `a-z`, so non-Latin names (`鈴木電子`) keep
 * their characters and stay distinct instead of all folding to the empty string.
 *
 * A name written entirely in punctuation still keys to `''`; callers reject blank names
 * before reaching here.
 */
export function supplierNameKey(raw: string): string {
  return (
    raw
      .normalize('NFD')
      // Combining marks left behind by NFD, so é and e converge.
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]/gu, '')
  );
}

/** True when two names denote the same supplier under {@link supplierNameKey}. */
export function isSameSupplierName(a: string, b: string): boolean {
  return supplierNameKey(a) === supplierNameKey(b);
}
