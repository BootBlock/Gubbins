/**
 * useApplyTheme — keep the document appearance in sync with the Tier-2 preferences.
 *
 * Mounted once at the composition root. `main.tsx` also applies the persisted appearance
 * synchronously before first paint to avoid a flash; this hook handles every later change (the
 * Settings mode/accent/OLED/contrast controls) reactively. When the mode is `'system'` it also
 * listens for OS `prefers-color-scheme` changes and re-applies live.
 */
import { useEffect } from 'react';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { applyAppearance, PREFERS_DARK_QUERY } from './theme';

export function useApplyTheme(): void {
  const mode = usePreferencesStore((s) => s.mode);
  const accent = usePreferencesStore((s) => s.accent);
  const oledDark = usePreferencesStore((s) => s.oledDark);
  const highContrast = usePreferencesStore((s) => s.highContrast);
  const animationLevel = usePreferencesStore((s) => s.animationLevel);
  const holographicCards = usePreferencesStore((s) => s.holographicCards);
  const gamifyCards = usePreferencesStore((s) => s.gamifyCards);
  const customAccentEnabled = usePreferencesStore((s) => s.customAccentEnabled);
  const customAccentHue = usePreferencesStore((s) => s.customAccentHue);
  const surfaceStyle = usePreferencesStore((s) => s.surfaceStyle);
  useEffect(() => {
    const appearance = {
      mode,
      accent,
      oledDark,
      highContrast,
      animationLevel,
      holographicCards,
      gamifyCards,
      customAccent: { enabled: customAccentEnabled, hue: customAccentHue },
      surfaceStyle,
    };
    applyAppearance(appearance);
    // Only the 'system' mode tracks the OS; an explicit choice needs no listener. (A custom accent
    // is mode-tuned, so this same listener re-applies its light/dark tokens when the OS flips.)
    if (mode !== 'system' || typeof matchMedia !== 'function') return;
    const media = matchMedia(PREFERS_DARK_QUERY);
    const onChange = () => applyAppearance(appearance);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [
    mode,
    accent,
    oledDark,
    highContrast,
    animationLevel,
    holographicCards,
    gamifyCards,
    customAccentEnabled,
    customAccentHue,
    surfaceStyle,
  ]);
}
