import { useEffect, useState, type ComponentType } from 'react';
import type { LucideProps } from '@/components/icons';

/**
 * Render a single stored glyph by its canonical Lucide name (spec §2.4.1).
 *
 * The glyph catalogue is large, so it lives behind a dynamic `import()` (see
 * {@link ./glyph-registry}); this component loads that shared chunk once (module-cached
 * across every `<Glyph>`) and, until it resolves — or when `name` is null/unknown —
 * renders the optional `fallback` (e.g. the domain's default icon). This keeps the main
 * bundle free of the full icon set while letting any surface display a chosen glyph.
 *
 * That fetch can fail — offline, or a stale service worker pointing at a chunk that is no
 * longer served. A failure must not be terminal: the rejected promise is deliberately **not**
 * cached, so the next `<Glyph>` to mount re-attempts the load, and every glyph still waiting
 * subscribes to that shared attempt so a later success reaches the ones already on screen
 * rather than leaving them showing their fallback forever.
 */

type Registry = typeof import('./glyph-registry');

let cached: Registry | null = null;
let pending: Promise<Registry> | null = null;
/** Mounted `<Glyph>`s still waiting on the catalogue, notified once any load succeeds. */
const waiting = new Set<() => void>();

function loadRegistry(): Promise<Registry> {
  if (cached) return Promise.resolve(cached);
  pending ??= import('./glyph-registry').then(
    (module) => {
      cached = module;
      pending = null;
      for (const notify of [...waiting]) notify();
      return module;
    },
    (error: unknown) => {
      // Drop the failed attempt rather than caching it, so a later caller retries the fetch
      // instead of re-awaiting a promise that can only ever reject.
      pending = null;
      throw error;
    },
  );
  return pending;
}

export interface GlyphProps extends Omit<LucideProps, 'name'> {
  /** Canonical Lucide glyph name (PascalCase), or null/undefined for "no glyph". */
  readonly name: string | null | undefined;
  /** Rendered while the catalogue loads, or when `name` is absent/unknown. */
  readonly fallback?: ComponentType<LucideProps>;
}

export function Glyph({ name, fallback: Fallback, ...props }: GlyphProps) {
  const [registry, setRegistry] = useState<Registry | null>(cached);

  useEffect(() => {
    if (registry) return;
    let active = true;
    const settle = () => {
      if (active && cached) setRegistry(cached);
    };
    waiting.add(settle);
    loadRegistry().then(settle, () => {
      // The catalogue chunk could not be fetched. Observe the rejection here — an unhandled one
      // would surface as a console error from an always-mounted component — and keep rendering
      // the fallback. The next `<Glyph>` to mount retries, and `waiting` delivers its result
      // back to this one.
    });
    return () => {
      active = false;
      waiting.delete(settle);
    };
  }, [registry]);

  const Icon = registry && name ? registry.getGlyphIcon(name) : undefined;
  if (Icon) return <Icon {...props} />;
  if (Fallback) return <Fallback {...props} />;
  return null;
}
