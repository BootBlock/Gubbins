import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useT } from './useT';
import { useApplyLanguage } from './useApplyLanguage';
import { useI18nStore } from './useI18nStore';
import { BASE_LANGUAGE, EN_CATALOG } from './messages';

function Probe() {
  const t = useT();
  return <span data-testid="probe">{t('nav.inventory')}</span>;
}

function LanguageHost() {
  useApplyLanguage();
  return <Probe />;
}

afterEach(() => {
  // Reset the runtime catalog + the locale preference between tests.
  act(() => {
    useI18nStore.getState().setLanguage(BASE_LANGUAGE, EN_CATALOG);
    usePreferencesStore.getState().setLocale('en-GB');
  });
});

describe('useT (React seam)', () => {
  it('returns the base English string by default', () => {
    render(<Probe />);
    expect(screen.getByTestId('probe')).toHaveTextContent('Inventory');
  });

  it('returns the active-language string once a translated catalog is loaded', () => {
    act(() => {
      useI18nStore.getState().setLanguage('de', { 'nav.inventory': 'Inventar' });
    });
    render(<Probe />);
    expect(screen.getByTestId('probe')).toHaveTextContent('Inventar');
  });

  it('falls back to English for a key the active catalog does not translate', () => {
    act(() => {
      // A partial German catalog missing `nav.inventory` falls back to the base.
      useI18nStore.getState().setLanguage('de', { 'nav.about': 'Über' });
    });
    render(<Probe />);
    expect(screen.getByTestId('probe')).toHaveTextContent('Inventory');
  });
});

describe('useApplyLanguage (locale → catalog)', () => {
  it('lazy-loads the German catalog when the locale selects German', async () => {
    act(() => {
      usePreferencesStore.getState().setLocale('de-DE');
    });
    render(<LanguageHost />);
    // The German catalog imports asynchronously; the base English shows until it lands.
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('Inventar'));
    expect(useI18nStore.getState().language).toBe('de');
  });

  it('applies the base English catalog synchronously for an English locale', () => {
    act(() => {
      usePreferencesStore.getState().setLocale('en-US');
    });
    render(<LanguageHost />);
    expect(screen.getByTestId('probe')).toHaveTextContent('Inventory');
    expect(useI18nStore.getState().language).toBe(BASE_LANGUAGE);
  });
});
