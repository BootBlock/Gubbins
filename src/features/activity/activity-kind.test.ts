import { describe, expect, it } from 'vitest';
import { HISTORY_ACTIONS } from '@/db/repositories';
import {
  ACTIVITY_KINDS,
  ACTIVITY_KIND_LABEL,
  actionsForKinds,
  activityKindForAction,
  type ActivityKind,
} from './activity-kind';

describe('activity-kind (Phase 80)', () => {
  it('maps every HistoryAction to a known kind', () => {
    for (const action of HISTORY_ACTIONS) {
      expect(ACTIVITY_KINDS).toContain(activityKindForAction(action));
    }
  });

  it('has a label for every kind', () => {
    for (const kind of ACTIVITY_KINDS) {
      expect(ACTIVITY_KIND_LABEL[kind]).toBeTruthy();
    }
  });

  it('falls back to lifecycle for an unknown (forward-compat) action', () => {
    expect(activityKindForAction('SOME_FUTURE_ACTION')).toBe('lifecycle');
  });

  it('groups representative actions sensibly', () => {
    expect(activityKindForAction('CREATED')).toBe('created');
    expect(activityKindForAction('GAUGE_UPDATE')).toBe('stock');
    expect(activityKindForAction('MOVED')).toBe('movement');
    expect(activityKindForAction('CHECKED_OUT')).toBe('loan');
    expect(activityKindForAction('RENAMED')).toBe('lifecycle');
    expect(activityKindForAction('SCRAPE_APPLIED')).toBe('supplier');
  });

  describe('actionsForKinds', () => {
    it('returns the full action list when all kinds are enabled', () => {
      const all = actionsForKinds(new Set(ACTIVITY_KINDS));
      expect(all.length).toBe(HISTORY_ACTIONS.length);
      expect([...all].sort()).toEqual([...HISTORY_ACTIONS].sort());
    });

    it('returns only the actions of the enabled kinds', () => {
      const loanOnly = actionsForKinds(new Set<ActivityKind>(['loan']));
      expect(loanOnly).toContain('CHECKED_OUT');
      expect(loanOnly).toContain('RESERVED');
      expect(loanOnly).not.toContain('GAUGE_UPDATE');
      expect(loanOnly.every((a) => activityKindForAction(a) === 'loan')).toBe(true);
    });

    it('returns an empty array when no kinds are enabled', () => {
      expect(actionsForKinds(new Set<ActivityKind>())).toEqual([]);
    });

    it('preserves the canonical HISTORY_ACTIONS order', () => {
      const subset = actionsForKinds(new Set<ActivityKind>(['created', 'stock']));
      const expected = HISTORY_ACTIONS.filter((a) => subset.includes(a));
      expect(subset).toEqual(expected);
    });
  });
});
