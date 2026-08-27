/**
 * The store-side Users-module backstop (issue #630).
 *
 * Issue #429 gates the three screens that can ask for this. These cases are about the rule
 * holding at the write itself — and, just as importantly, about the one caller it must never
 * refuse: the sign-in screen's lockout escape hatch.
 */
import { describe, expect, it } from 'vitest';
import { UNRESTRICTED_AUTHORITY, type Authority } from '@/features/users/permissions';
import { FEATURE_REGISTRY, OPTIONAL_FEATURE_IDS } from './feature-registry';
import { resolveEnabled } from './modules-graph';
import { PRESETS } from './presets';
import {
  guardUsersIntent,
  mayDisableUsersModule,
  USERS_FEATURE_ID,
  USERS_MODULE_DISABLE_PERMISSION,
} from './users-module-guard';

const VIEWER: Authority = { mode: 'granted', grants: new Set(['items:read']) };
const MANAGER: Authority = {
  // The built-in Manager holds every subject bar `users` and `modules`, of which it reads only.
  mode: 'granted',
  grants: new Set(['settings:*', 'items:*', 'users:read', 'modules:read']),
};
const ADMINISTRATOR: Authority = { mode: 'granted', grants: new Set(['*']) };
/** Signed in, but with no role at all — denies everything, and is not the escape hatch. */
const NO_ROLE: Authority = { mode: 'denied', reason: 'no-role' };

const signedInAs = (authority: Authority) => ({ authority, signedIn: true });
const nobodySignedIn = { authority: { mode: 'denied', reason: 'signed-out' } as Authority, signedIn: false };

const ON = { [USERS_FEATURE_ID]: true };
const OFF = { [USERS_FEATURE_ID]: false };

/** Whether the module is on for a given intent, read exactly as the app reads it. */
const isOn = (intent: Readonly<Record<string, boolean>>) =>
  resolveEnabled(intent, FEATURE_REGISTRY).has(USERS_FEATURE_ID);

describe('mayDisableUsersModule', () => {
  it('asks for the same key the Modules screen does', () => {
    expect(USERS_MODULE_DISABLE_PERMISSION).toBe('modules:write');
  });

  it('always lets a signed-out device through — that is the lockout escape hatch', () => {
    // The sign-in screen's "Can't sign in?" button writes the same intent as the Modules screen's
    // toggle, from a device whose authority denies everything. Refusing it would build exactly the
    // one-way door the feature promises never to build: a forgotten password with no way back.
    expect(mayDisableUsersModule(nobodySignedIn)).toBe(true);
  });

  it('refuses a signed-in account without `modules:write`', () => {
    expect(mayDisableUsersModule(signedInAs(VIEWER))).toBe(false);
    // Manager holds `settings:*` and deliberately not `modules:write`, so it is refused too.
    expect(mayDisableUsersModule(signedInAs(MANAGER))).toBe(false);
    // Denied for want of a role is not the same state as nobody being signed in, even though both
    // permit nothing. Such an account is not stranded — it can sign out, which puts the hatch back.
    expect(mayDisableUsersModule(signedInAs(NO_ROLE))).toBe(false);
  });

  it('permits an administrator, and single-user mode unconditionally', () => {
    expect(mayDisableUsersModule(signedInAs(ADMINISTRATOR))).toBe(true);
    expect(mayDisableUsersModule(signedInAs(UNRESTRICTED_AUTHORITY))).toBe(true);
  });
});

describe('guardUsersIntent', () => {
  it('pins the module on when the session may not switch it off', () => {
    expect(isOn(guardUsersIntent(ON, OFF, signedInAs(VIEWER)))).toBe(true);
    expect(isOn(guardUsersIntent(ON, OFF, signedInAs(MANAGER)))).toBe(true);
  });

  it('lets an administrator, and a signed-out device, switch it off', () => {
    expect(isOn(guardUsersIntent(ON, OFF, signedInAs(ADMINISTRATOR)))).toBe(false);
    expect(isOn(guardUsersIntent(ON, OFF, nobodySignedIn))).toBe(false);
  });

  it('pins it against a reset to registry defaults, where `users` defaults off', () => {
    // Clearing every override is a disable path too, and reads nothing like one at the call site.
    expect(isOn(guardUsersIntent(ON, {}, signedInAs(VIEWER)))).toBe(true);
    expect(isOn(guardUsersIntent(ON, {}, signedInAs(ADMINISTRATOR)))).toBe(false);
  });

  it('pins it against every preset, without discarding the rest of the preset', () => {
    for (const preset of PRESETS) {
      const proposed = Object.fromEntries(
        OPTIONAL_FEATURE_IDS.map((id) => [id, preset.featureIds.includes(id)]),
      );
      const guarded = guardUsersIntent(ON, proposed, signedInAs(VIEWER));
      expect(isOn(guarded)).toBe(true);
      // Everything the preset asked for still applies — one module is pinned, the choice is not
      // rejected.
      for (const id of OPTIONAL_FEATURE_IDS) {
        if (id === USERS_FEATURE_ID) continue;
        expect(guarded[id]).toBe(proposed[id]);
      }
    }
  });

  it('never obstructs switching the module on, whoever asks', () => {
    // The on direction has its own confirmation (it can lock somebody out); it is not this
    // guard's business, and blocking it would strand a device that is signed out.
    expect(isOn(guardUsersIntent(OFF, ON, signedInAs(VIEWER)))).toBe(true);
    expect(isOn(guardUsersIntent(OFF, ON, nobodySignedIn))).toBe(true);
  });

  it('passes a change that leaves the module where it was straight through', () => {
    const proposed = { ...ON, projects: false };
    expect(guardUsersIntent(ON, proposed, signedInAs(VIEWER))).toEqual(proposed);
    // And with the module already off there is nothing to protect: single-user mode resolves
    // unrestricted anyway, so the guard must be invisible there.
    const offToOff = { ...OFF, projects: false };
    expect(guardUsersIntent(OFF, offToOff, signedInAs(NO_ROLE))).toEqual(offToOff);
  });
});
