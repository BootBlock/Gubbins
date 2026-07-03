import { createContext, useContext } from 'react';

/**
 * Guide-wide state shared between steps.
 *
 * The one piece of state that must cross step boundaries is the **bridge access token**: the
 * "Access token" step mints it, and later steps ("Run the bridge", "Connect") splice it into
 * the exact `.env` line and config the user should use — so they never have to copy it back
 * and forth. It lives only in memory for the session (it is a secret; the guide never persists
 * it unless the user explicitly saves it to this device on the token step).
 */
export interface GuideState {
  /** The bridge bearer token the user generated or typed, or `''` if not set yet. */
  readonly token: string;
  readonly setToken: (token: string) => void;
}

/** A neutral placeholder shown in command snippets before a token exists. */
export const TOKEN_PLACEHOLDER = '<YOUR_BRIDGE_TOKEN>';

const GuideContext = createContext<GuideState | null>(null);

export const GuideProvider = GuideContext.Provider;

/** Read guide-wide state. Throws if used outside the guide screen (a wiring bug). */
export function useGuide(): GuideState {
  const value = useContext(GuideContext);
  if (value === null) throw new Error('useGuide must be used within the Home Assistant setup guide.');
  return value;
}

/** The token to show in a command snippet — the real one once set, else a clear placeholder. */
export function tokenForDisplay(token: string): string {
  return token.trim().length > 0 ? token.trim() : TOKEN_PLACEHOLDER;
}
