/**
 * usePreferencesStore — Tier-2 user preferences (spec §2.1, §1.2.1, §3).
 *
 * Base currency, locale and theme, persisted to localStorage. Defaults follow the
 * locked derived defaults: GBP / en-GB (§1.2.1). The theme palette is wired in CSS
 * (dark default); this store is the home for the Dark/Light toggle.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Theme = 'dark' | 'light';

interface PreferencesStore {
  readonly baseCurrency: string;
  readonly locale: string;
  readonly theme: Theme;
  setBaseCurrency: (currency: string) => void;
  setLocale: (locale: string) => void;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

export const usePreferencesStore = create<PreferencesStore>()(
  persist(
    (set) => ({
      baseCurrency: 'GBP',
      locale: 'en-GB',
      theme: 'dark',
      setBaseCurrency: (baseCurrency) => set({ baseCurrency }),
      setLocale: (locale) => set({ locale }),
      setTheme: (theme) => set({ theme }),
      toggleTheme: () => set((state) => ({ theme: state.theme === 'dark' ? 'light' : 'dark' })),
    }),
    { name: 'gubbins:preferences' },
  ),
);
