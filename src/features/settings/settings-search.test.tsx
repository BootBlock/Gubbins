/**
 * Unit tests for the Settings search seam (issue #133) — the matching rules, and the
 * container plumbing that decides what is left showing.
 *
 * These drive the seam through the real {@link SettingsSection} / {@link SettingRow}
 * primitives rather than a stand-in, because the whole design rests on rows matching
 * themselves and reporting up: a section that hides when it shouldn't (or refuses to) is
 * exactly the bug worth catching, and it only appears once the two are composed.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { SettingsSection, SettingRow } from './SettingsSection';
import { SettingsSearchGroup, SettingsSearchResults } from './SettingsSearchResults';
import { matchesSettingSearch, type SettingsSearchScope } from './settings-search';

afterEach(cleanup);

/** A scope with no container labels above it — a row matching purely on its own text. */
const BARE: SettingsSearchScope = { text: '', matched: false };

describe('matchesSettingSearch', () => {
  it('needs every term, case-insensitively, somewhere across the row and its containers', () => {
    const scope: SettingsSearchScope = { text: 'Scanning & labels Scanner', matched: false };
    expect(matchesSettingSearch(['beep'], scope, ['Beep on scan', 'Play a tone.'])).toBe(true);
    // The section supplies "scanner", the row supplies "beep" — neither matches alone.
    expect(matchesSettingSearch(['scanner', 'beep'], scope, ['Beep on scan', 'Play a tone.'])).toBe(true);
    expect(matchesSettingSearch(['beep', 'vibrate'], scope, ['Beep on scan', 'Play a tone.'])).toBe(false);
  });

  it('matches everything when the query is empty or a container already answered it', () => {
    expect(matchesSettingSearch([], BARE, ['Anything'])).toBe(true);
    expect(matchesSettingSearch(['nonsense'], { text: 'Hotkeys', matched: true }, ['Row'])).toBe(true);
  });

  it('ignores absent parts rather than matching on the gap they leave', () => {
    expect(matchesSettingSearch(['on', 'scan'], BARE, ['Beep on scan', undefined, ''])).toBe(true);
    expect(matchesSettingSearch(['hint'], BARE, ['Beep on scan', undefined])).toBe(false);
  });
});

/**
 * Two tab groups' worth of settings — one row each, plus a section that holds no rows at all
 * (the shape of the real "Card fields" picker). Group labels are kept distinct from the
 * section titles inside them so each can be asserted on separately.
 */
function Fixture({ query }: { readonly query: string }) {
  return (
    <SettingsSearchResults query={query}>
      <SettingsSearchGroup label="Appearance">
        <SettingsSection icon={null} title="Theme">
          <SettingRow
            label="Pure black (OLED)"
            description="Use a true-black background in dark mode."
            hint="Deeper contrast, and a little less battery use."
          >
            <button type="button">oled-control</button>
          </SettingRow>
        </SettingsSection>
      </SettingsSearchGroup>

      <SettingsSearchGroup label="Data & storage">
        <SettingsSection icon={null} title="Storage">
          <SettingRow label="Default purge window" description="The history age triage defaults to.">
            <button type="button">purge-control</button>
          </SettingRow>
        </SettingsSection>
        <SettingsSection icon={null} title="Card fields">
          <p>A picker, not a row list.</p>
        </SettingsSection>
      </SettingsSearchGroup>
    </SettingsSearchResults>
  );
}

/** Whether the `SettingsSection` card carrying this heading is filtered out of view. */
function sectionHidden(title: string): boolean {
  return screen.getByRole('heading', { name: title }).closest('div.p-5')!.className.includes('hidden');
}

describe('the results view', () => {
  it('keeps the matching row and drops the rest, wherever their tab', () => {
    render(<Fixture query="history" />);

    expect(screen.getByText('purge-control')).toBeInTheDocument();
    expect(screen.queryByText('oled-control')).toBeNull();
    // The other tab's section stays mounted — it is what reports the emptiness — but hidden.
    expect(sectionHidden('Theme')).toBe(true);
    expect(sectionHidden('Storage')).toBe(false);
    expect(screen.getByTestId('settings-search-count')).toHaveTextContent('1 setting matches');
  });

  it('matches on the rich hint, not just the visible label and description', () => {
    render(<Fixture query="battery" />);
    expect(screen.getByText('oled-control')).toBeInTheDocument();
    expect(screen.queryByText('purge-control')).toBeNull();
  });

  it('combines a term from the section with a term from the row', () => {
    render(<Fixture query="storage history" />);
    expect(screen.getByText('purge-control')).toBeInTheDocument();
    expect(screen.queryByText('oled-control')).toBeNull();
  });

  it('keeps a whole tab when the query is answered by the tab label alone', () => {
    render(<Fixture query="appearance" />);
    expect(screen.getByText('oled-control')).toBeInTheDocument();
    expect(sectionHidden('Theme')).toBe(false);
    expect(sectionHidden('Storage')).toBe(true);
  });

  it('keeps a section with no rows at all when its own title matches', () => {
    render(<Fixture query="card fields" />);
    expect(sectionHidden('Card fields')).toBe(false);
    expect(sectionHidden('Storage')).toBe(true);
    expect(screen.getByTestId('settings-search-count')).toHaveTextContent('1 setting matches');
  });

  it('names the query it found nothing for', () => {
    render(<Fixture query="  flux capacitor  " />);
    expect(screen.getByTestId('settings-search-empty')).toHaveTextContent('flux capacitor');
    expect(screen.getByTestId('settings-search-count')).toHaveTextContent('0 settings match');
  });
});

describe('outside the results view', () => {
  it('leaves every row and section showing — the unfiltered dialog is untouched', () => {
    render(
      <SettingsSection icon={null} title="Theme">
        <SettingRow label="Pure black (OLED)" description="A true-black background.">
          <button type="button">oled-control</button>
        </SettingRow>
      </SettingsSection>,
    );
    expect(screen.getByText('oled-control')).toBeInTheDocument();
    expect(sectionHidden('Theme')).toBe(false);
  });
});
