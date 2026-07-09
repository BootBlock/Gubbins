import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/index.css';
import { App } from './App';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { applyAppearance } from '@/features/settings/theme';
import { completeGoogleAuthRedirect } from '@/features/sync/providers/google-oauth';

// Complete an in-progress Google Drive sign-in *before* the hash router mounts: this lifts
// any OAuth token fragment out of the URL (storing the token) so the router never tries to
// route it, then rewrites the location to the Sync screen. A no-op on an ordinary load.
completeGoogleAuthRedirect();

// Project the persisted appearance (mode + accent + OLED + high-contrast) onto the document
// before first paint (no flash). The store hydrates synchronously from localStorage, so this
// reflects the saved choice.
{
  const s = usePreferencesStore.getState();
  applyAppearance({ mode: s.mode, accent: s.accent, oledDark: s.oledDark, highContrast: s.highContrast });
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Gubbins could not start: #root element is missing from the document.');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
