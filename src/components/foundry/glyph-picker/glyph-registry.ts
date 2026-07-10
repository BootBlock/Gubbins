/**
 * The full Lucide glyph catalogue, for the app-wide icon picker (spec §2.4.1).
 *
 * The central icon registry (`@/components/icons`) re-exports a small, semantically
 * named subset that the UI uses by hand. The *picker*, by contrast, needs the whole
 * catalogue so a user can search all ~1,700 glyphs. Importing every icon is heavy, so
 * this module is only ever reached through a dynamic `import()` — from {@link Glyph}
 * (single-icon display) and the lazy {@link GlyphPicker} — which lets the bundler split
 * the catalogue into one shared async chunk that loads on demand and precaches once for
 * offline use, rather than bloating the main bundle.
 *
 * A glyph is referenced by its canonical Lucide component name in PascalCase (a key of
 * `icons`); {@link getGlyphIcon} resolves that to a renderable component.
 */
import { icons, type LucideIcon } from 'lucide-react';

/** All catalogue glyph names (canonical Lucide PascalCase), sorted alphabetically. */
export const GLYPH_NAMES: readonly string[] = Object.keys(icons).sort((a, b) => a.localeCompare(b));

/** Resolve a stored glyph name to its Lucide component, or `undefined` if unknown. */
export function getGlyphIcon(name: string): LucideIcon | undefined {
  return (icons as Record<string, LucideIcon>)[name];
}

/** Whether a name resolves to a real catalogue glyph. */
export function isGlyphName(name: string | null | undefined): name is string {
  return name != null && name in icons;
}
