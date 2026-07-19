/**
 * Whether the users module is switched on (issue #79, plan §3).
 *
 * One function, in one file, because it is the switch the whole feature hangs off: with it
 * **off** Gubbins behaves exactly as it always has — no sign-in, no permission ever refused,
 * every action attributed to the built-in Admin — and the user never meets the concept.
 *
 * It reads the Modular UI store, so the module is switched on and off from the Modules manager
 * like any other feature and the state lives in exactly one place. `users` is declared
 * `defaultOff` in the feature registry: the store's usual "a feature with no stored intent is
 * on" rule would otherwise have turned sign-in and permission enforcement on for every existing
 * install the moment this shipped.
 *
 * Deliberately **not** a hook. The repository layer, `authority-refresh` and the sign-in gate
 * all ask this question outside a render, and a second, hook-shaped copy of it is how the two
 * answers would drift. Components that need to re-render on the toggle use
 * `useFeature('users')` directly.
 */
import { isFeatureEnabled } from '@/features/modules/useFeature';

export function usersModuleEnabled(): boolean {
  return isFeatureEnabled('users');
}
