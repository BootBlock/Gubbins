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

/**
 * Datasheet/attachment configuration (spec §4 "Attachments & Datasheets"):
 * - `URL_ONLY` (Option A) — only external URLs may be linked.
 * - `HYBRID` (Option B) — external URLs *and* local file-path pointers (the
 *   File System Access path string is stored; the blob is never synced, §4).
 */
export type AttachmentMode = 'URL_ONLY' | 'HYBRID';

interface PreferencesStore {
  readonly baseCurrency: string;
  readonly locale: string;
  readonly theme: Theme;
  readonly attachmentMode: AttachmentMode;
  setBaseCurrency: (currency: string) => void;
  setLocale: (locale: string) => void;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  setAttachmentMode: (mode: AttachmentMode) => void;
}

export const usePreferencesStore = create<PreferencesStore>()(
  persist(
    (set) => ({
      baseCurrency: 'GBP',
      locale: 'en-GB',
      theme: 'dark',
      attachmentMode: 'URL_ONLY',
      setBaseCurrency: (baseCurrency) => set({ baseCurrency }),
      setLocale: (locale) => set({ locale }),
      setTheme: (theme) => set({ theme }),
      toggleTheme: () => set((state) => ({ theme: state.theme === 'dark' ? 'light' : 'dark' })),
      setAttachmentMode: (attachmentMode) => set({ attachmentMode }),
    }),
    { name: 'gubbins:preferences' },
  ),
);
