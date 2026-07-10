import { describe, expect, it } from 'vitest';
import { NAV_DESTINATIONS } from '@/components/nav/nav-destinations';
import { DASHBOARD_WIDGETS } from '@/features/dashboard/widgets';
import { EN_CATALOG } from './messages';

/**
 * Drift guard (feature-gap G4). Two data registries keep an English string *beside* their i18n
 * key: `NAV_DESTINATIONS[].label` (still used as command-palette search text + the base fallback)
 * and `DASHBOARD_WIDGETS[].title` (the English reference for a translated widget title). The
 * displayed text comes from `t(key)`, so these English fields are only meaningful if they stay
 * byte-identical to the catalog's English value — that identity is also what keeps the existing
 * screen tests (which assert the English copy) green. Assert it so a rename of one but not the
 * other fails loudly instead of silently diverging.
 */
describe('catalog ↔ registry drift', () => {
  it('every nav destination label equals its message key in the English catalog', () => {
    for (const dest of NAV_DESTINATIONS) {
      expect(EN_CATALOG[dest.messageKey], `nav ${dest.to}`).toBe(dest.label);
    }
  });

  it('every dashboard widget title equals its title key in the English catalog', () => {
    for (const widget of DASHBOARD_WIDGETS) {
      expect(EN_CATALOG[widget.titleKey], `widget ${widget.id}`).toBe(widget.title);
    }
  });
});
