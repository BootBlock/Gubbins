import { describe, it, expect } from 'vitest';
import type { ProjectBudget } from '@/db/repositories';
import {
  budgetStatus,
  projectBudgetHealth,
  spentFraction,
  summariseBudget,
  summariseBudgetCategory,
} from './budget';

const facts = (over: Partial<ProjectBudget> = {}): ProjectBudget => ({
  budget: 500,
  estimatedCost: 420,
  committedFromBom: 180,
  manualExpenseTotal: 60,
  categories: [],
  uncategorisedExpenseTotal: 60,
  ...over,
});

describe('budgetStatus', () => {
  it('is NONE when no budget is set', () => {
    expect(budgetStatus(100, null, 80)).toBe('NONE');
  });

  it('is OK comfortably under the warning line', () => {
    expect(budgetStatus(50, 100, 80)).toBe('OK');
  });

  it('is WARN at or above the warning threshold but not over budget', () => {
    expect(budgetStatus(80, 100, 80)).toBe('WARN'); // exactly on the line
    expect(budgetStatus(95, 100, 80)).toBe('WARN');
    expect(budgetStatus(100, 100, 80)).toBe('WARN'); // exactly on budget
  });

  it('is OVER once spend exceeds the budget', () => {
    expect(budgetStatus(101, 100, 80)).toBe('OVER');
  });

  it('treats a zero/negative limit as OVER only when there is positive spend', () => {
    expect(budgetStatus(0, 0, 80)).toBe('OK');
    expect(budgetStatus(1, 0, 80)).toBe('OVER');
    expect(budgetStatus(5, -10, 80)).toBe('OVER');
  });

  it('honours a tighter or looser warn percent', () => {
    expect(budgetStatus(50, 100, 40)).toBe('WARN'); // tight: warn from 40%
    expect(budgetStatus(50, 100, 100)).toBe('OK'); // loose: only warn at 100%
  });
});

describe('projectBudgetHealth', () => {
  const warnPercent = 80;

  it('flags over when spend so far has passed the budget', () => {
    // committed + expenses = 110 > 100.
    expect(
      projectBudgetHealth(
        { budget: 100, committedFromBom: 90, manualExpenseTotal: 20, estimatedCost: 90 },
        warnPercent,
      ),
    ).toEqual({
      over: true,
      warn: false,
    });
  });

  it('flags over when the projected final cost has passed the budget, even if spend so far is fine', () => {
    // spend so far = 30 (OK); projected = estimate 90 + expenses 20 = 110 > 100.
    expect(
      projectBudgetHealth(
        { budget: 100, committedFromBom: 10, manualExpenseTotal: 20, estimatedCost: 90 },
        warnPercent,
      ),
    ).toEqual({
      over: true,
      warn: false,
    });
  });

  it('flags warn (not over) in the warning band', () => {
    // spend so far = 85 (≥80% and ≤100%); projected = 85 too.
    expect(
      projectBudgetHealth(
        { budget: 100, committedFromBom: 85, manualExpenseTotal: 0, estimatedCost: 85 },
        warnPercent,
      ),
    ).toEqual({
      over: false,
      warn: true,
    });
  });

  it('flags neither when comfortably within budget', () => {
    expect(
      projectBudgetHealth(
        { budget: 100, committedFromBom: 10, manualExpenseTotal: 0, estimatedCost: 10 },
        warnPercent,
      ),
    ).toEqual({
      over: false,
      warn: false,
    });
  });
});

describe('spentFraction', () => {
  it('divides spend by the limit', () => {
    expect(spentFraction(50, 100)).toBe(0.5);
    expect(spentFraction(120, 100)).toBeCloseTo(1.2);
  });

  it('is null for a null or non-positive limit (no divide-by-zero)', () => {
    expect(spentFraction(10, null)).toBeNull();
    expect(spentFraction(10, 0)).toBeNull();
    expect(spentFraction(10, -5)).toBeNull();
  });
});

describe('summariseBudget', () => {
  it('sums the two spend lanes into totalSpent and remaining', () => {
    const s = summariseBudget(facts(), 80);
    expect(s.totalSpent).toBe(240); // 180 committed + 60 manual
    expect(s.remaining).toBe(260); // 500 − 240
    expect(s.spentFraction).toBeCloseTo(0.48);
    expect(s.status).toBe('OK');
  });

  it('projects the final cost from the full estimate plus manual expenses', () => {
    const s = summariseBudget(facts(), 80);
    expect(s.projectedFinalCost).toBe(480); // 420 estimate + 60 manual
    expect(s.projectedRemaining).toBe(20);
    expect(s.projectedStatus).toBe('WARN'); // 480 ≥ 80% of 500
  });

  it('does not double-count committed spend inside the projection', () => {
    // committedFromBom (180) is a subset of estimatedCost (420); the projection uses the
    // full estimate, never estimate + committed.
    const s = summariseBudget(facts({ committedFromBom: 420 }), 80);
    expect(s.projectedFinalCost).toBe(480);
  });

  it('flags OVER when spend exceeds the budget', () => {
    const s = summariseBudget(facts({ committedFromBom: 500, manualExpenseTotal: 80 }), 80);
    expect(s.totalSpent).toBe(580);
    expect(s.remaining).toBe(-80);
    expect(s.status).toBe('OVER');
  });

  it('yields null comparisons when no budget is set', () => {
    const s = summariseBudget(facts({ budget: null }), 80);
    expect(s.remaining).toBeNull();
    expect(s.projectedRemaining).toBeNull();
    expect(s.spentFraction).toBeNull();
    expect(s.projectedFraction).toBeNull();
    expect(s.status).toBe('NONE');
    expect(s.projectedStatus).toBe('NONE');
    // The raw figures still flow through for display.
    expect(s.totalSpent).toBe(240);
  });

  it('rolls each budget category up and passes the uncategorised total through', () => {
    const s = summariseBudget(
      facts({
        categories: [
          { id: 'c1', name: 'Parts', amount: 300, spent: 180, position: 0 },
          { id: 'c2', name: 'Shipping', amount: 50, spent: 60, position: 1 },
        ],
        uncategorisedExpenseTotal: 20,
      }),
      80,
    );
    expect(s.categories).toHaveLength(2);
    expect(s.categories[0]).toMatchObject({ name: 'Parts', remaining: 120, status: 'OK' });
    expect(s.categories[1]).toMatchObject({ name: 'Shipping', remaining: -10, status: 'OVER' });
    expect(s.uncategorisedExpenseTotal).toBe(20);
  });
});

describe('summariseBudgetCategory', () => {
  it('computes remaining and status against the allocation', () => {
    const c = summariseBudgetCategory({ id: 'c1', name: 'Labour', amount: 100, spent: 90, position: 0 }, 80);
    expect(c.remaining).toBe(10);
    expect(c.spentFraction).toBeCloseTo(0.9);
    expect(c.status).toBe('WARN');
  });

  it('is OVER when a category is overspent', () => {
    const c = summariseBudgetCategory({ id: 'c1', name: 'Tools', amount: 50, spent: 75, position: 0 }, 80);
    expect(c.remaining).toBe(-25);
    expect(c.status).toBe('OVER');
  });
});

// Issue #288: a budget card's own figures must reconcile with each other.
describe('monetary rounding', () => {
  it('makes a category row subtract correctly once quantised', () => {
    // Raw 0.025 / 0.014 publish as 0.03 / 0.01; a remaining taken from the raw difference
    // would read 0.01 against two figures that visibly subtract to 0.02.
    const c = summariseBudgetCategory(
      { id: 'c1', name: 'Odds', amount: 0.025, spent: 0.014, position: 0 },
      80,
    );
    expect(c.amount).toBe(0.03);
    expect(c.spent).toBe(0.01);
    expect(c.remaining).toBe(0.02);
  });

  it('keeps the summary self-consistent: committed + manual = spent, budget − spent = remaining', () => {
    const s = summariseBudget(
      facts({ budget: 1, estimatedCost: 0.7, committedFromBom: 0.1 * 3, manualExpenseTotal: 0.1 }),
      80,
    );
    expect(s.committedFromBom).toBe(0.3);
    expect(s.manualExpenseTotal).toBe(0.1);
    expect(s.totalSpent).toBe(0.4);
    expect(s.totalSpent).toBe(s.committedFromBom + s.manualExpenseTotal);
    expect(s.remaining).toBe(0.6);
    expect(s.projectedFinalCost).toBe(0.8);
    expect(s.projectedRemaining).toBeCloseTo(0.2, 10);
  });

  it('still classifies status from the raw figures, not a rounded penny', () => {
    // Raw spend 0.994 of a 1.00 budget is under; it publishes as 0.99 either way, but the
    // status must not be decided on the rounded value.
    const s = summariseBudget(
      facts({ budget: 1, estimatedCost: 0, committedFromBom: 0.994, manualExpenseTotal: 0 }),
      99,
    );
    expect(s.status).toBe('WARN');
    expect(s.spentFraction).toBeCloseTo(0.994, 10);
  });
});
