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
 */

type Registry = typeof import('./glyph-registry');

let cached: Registry | null = null;
let pending: Promise<Registry> | null = null;

function loadRegistry(): Promise<Registry> {
  if (cached) return Promise.resolve(cached);
  pending ??= import('./glyph-registry').then((module) => {
    cached = module;
    return module;
  });
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
    void loadRegistry().then((module) => {
      if (active) setRegistry(module);
    });
    return () => {
      active = false;
    };
  }, [registry]);

  const Icon = registry && name ? registry.getGlyphIcon(name) : undefined;
  if (Icon) return <Icon {...props} />;
  if (Fallback) return <Fallback {...props} />;
  return null;
}
