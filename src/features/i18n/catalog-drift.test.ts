import { describe, expect, it } from 'vitest';
import { NAV_DESTINATIONS } from '@/components/nav/nav-destinations';
import { OCCASIONS } from '@/components/background/seasonal';
import { DASHBOARD_WIDGETS } from '@/features/dashboard/widgets';
import { HOTKEY_ACTIONS } from '@/features/hotkeys/hotkeys';
import { LAB_FLAGS } from '@/features/lab/lab-flags';
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

  it('every hotkey action label equals its message key in the English catalog', () => {
    for (const action of HOTKEY_ACTIONS) {
      expect(EN_CATALOG[action.messageKey], `hotkey ${action.id}`).toBe(action.label);
    }
  });

  it('every seasonal occasion label and window equals its message key in the English catalog', () => {
    for (const occasion of OCCASIONS) {
      expect(EN_CATALOG[occasion.labelKey], `occasion ${occasion.id} label`).toBe(occasion.label);
      expect(EN_CATALOG[occasion.windowKey], `occasion ${occasion.id} window`).toBe(occasion.window);
    }
  });

  it('every lab flag label and description equals its message key in the English catalog', () => {
    for (const flag of LAB_FLAGS) {
      expect(EN_CATALOG[flag.labelKey], `flag ${flag.id} label`).toBe(flag.label);
      expect(EN_CATALOG[flag.descriptionKey], `flag ${flag.id} description`).toBe(flag.description);
    }
  });
});
