/**
 * Narrowing a category's stored lookup sources to the ones this build can actually run
 * (issue #616, phase L0).
 *
 * Storage keeps entries verbatim — including a provider id written by a peer on a newer version
 * — so a round-trip through this device can't discard a choice it doesn't understand. This is
 * the boundary where that tolerance ends: an id with no provider in this build's registry simply
 * offers no lookup here. Exactly the split `category-capabilities.ts` draws for
 * `hidden_capabilities`, and for the same reason.
 */
import type { CategoryLookupSource } from '@/db/repositories';
import { getLookupProvider } from './registry';
import type { LookupProvider } from './types';

/** A stored source paired with the provider it resolved to. */
export interface ResolvedLookupSource {
  readonly provider: LookupProvider;
  /** The category's explicit output-key → target overrides for this provider; null when none. */
  readonly fieldMap: Readonly<Record<string, string>> | null;
}

/**
 * The stored sources this build recognises, in stored order.
 *
 * Filters rather than throwing: an unresolvable id is an ordinary state (a newer peer, or a
 * provider withdrawn from a later build), not a fault.
 */
export function resolveLookupSources(
  sources: readonly CategoryLookupSource[] | null | undefined,
): readonly ResolvedLookupSource[] {
  if (sources == null || sources.length === 0) return [];
  const resolved: ResolvedLookupSource[] = [];
  for (const source of sources) {
    const provider = getLookupProvider(source.providerId);
    if (provider === undefined) continue;
    resolved.push({ provider, fieldMap: source.fieldMap });
  }
  return resolved;
}

/**
 * Whether a category offers any lookup this build can run — the cheap guard that keeps the
 * common case free. A category with no provider attached renders no affordance at all, so the
 * item detail dialog never pays for the feature.
 */
export function hasRunnableLookup(sources: readonly CategoryLookupSource[] | null | undefined): boolean {
  return resolveLookupSources(sources).length > 0;
}
