import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/index.css';
import { App } from './App';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { applyTheme } from '@/features/settings/theme';

// Project the persisted theme onto the document before first paint (no flash). The
// store hydrates synchronously from localStorage, so this reflects the saved choice.
applyTheme(usePreferencesStore.getState().theme);

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Gubbins could not start: #root element is missing from the document.');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
