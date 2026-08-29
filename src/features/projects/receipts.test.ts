import { describe, it, expect } from 'vitest';
import { TRACKING_MODES } from '@/db/repositories';
import {
  planReceipt,
  outstandingQty,
  receiptLandingFor,
  recordOnlyReason,
  recordOnlyReceiptReason,
} from './receipts';
import { EN_CATALOG } from '@/features/i18n/messages';

describe('planReceipt (spec §4 partial / split receipts)', () => {
  it('defaults an unspecified quantity to the full outstanding remainder', () => {
    const plan = planReceipt(5, 0);
    expect(plan).toEqual({
      receivedDelta: 5,
      nextReceivedQty: 5,
      outstandingQty: 0,
      fullyReceived: true,
    });
  });

  it('receives an instalment smaller than the requirement, leaving the line open', () => {
    const plan = planReceipt(5, 0, 2);
    expect(plan).toEqual({
      receivedDelta: 2,
      nextReceivedQty: 2,
      outstandingQty: 3,
      fullyReceived: false,
    });
  });

  it('accumulates onto an earlier instalment, completing the line', () => {
    // 2 already received; receiving the remaining 3 completes it.
    const plan = planReceipt(5, 2, 3);
    expect(plan).toEqual({
      receivedDelta: 3,
      nextReceivedQty: 5,
      outstandingQty: 0,
      fullyReceived: true,
    });
  });

  it('clamps an over-receipt to the outstanding remainder (never overshoots)', () => {
    // Only 3 outstanding; asking for 10 accepts just 3.
    const plan = planReceipt(5, 2, 10);
    expect(plan).toEqual({
      receivedDelta: 3,
      nextReceivedQty: 5,
      outstandingQty: 0,
      fullyReceived: true,
    });
  });

  it('floors fractional and rejects negative requested quantities', () => {
    expect(planReceipt(5, 0, 2.9).receivedDelta).toBe(2);
    const negative = planReceipt(5, 0, -4);
    expect(negative.receivedDelta).toBe(0);
    expect(negative.nextReceivedQty).toBe(0);
    expect(negative.fullyReceived).toBe(false);
  });

  it('is a no-op once the line is already fully received', () => {
    const plan = planReceipt(5, 5, 3);
    expect(plan).toEqual({
      receivedDelta: 0,
      nextReceivedQty: 5,
      outstandingQty: 0,
      fullyReceived: true,
    });
  });

  it('treats a zero-requirement line as immediately complete', () => {
    expect(planReceipt(0, 0)).toEqual({
      receivedDelta: 0,
      nextReceivedQty: 0,
      outstandingQty: 0,
      fullyReceived: true,
    });
  });
});

describe('outstandingQty', () => {
  it('is the requirement less what has already arrived, floored at zero', () => {
    expect(outstandingQty({ requiredQty: 5, receivedQty: 0 })).toBe(5);
    expect(outstandingQty({ requiredQty: 5, receivedQty: 2 })).toBe(3);
    expect(outstandingQty({ requiredQty: 5, receivedQty: 5 })).toBe(0);
    // Defensive: a received figure beyond the requirement never goes negative.
    expect(outstandingQty({ requiredQty: 5, receivedQty: 7 })).toBe(0);
  });
});

describe('receiptLandingFor (issue #608)', () => {
  it('lands stock for a bulk item, the one mode with a countable quantity', () => {
    expect(receiptLandingFor('DISCRETE')).toBe('COUNT');
  });

  it('is record-only for every mode that holds no counted quantity', () => {
    expect(receiptLandingFor('SERIALISED')).toBe('RECORD_ONLY');
    expect(receiptLandingFor('CONSUMABLE_GAUGE')).toBe('RECORD_ONLY');
    expect(receiptLandingFor('UNTRACKED')).toBe('RECORD_ONLY');
  });

  // Adding a tracking mode to the SSOT must not silently make its receipts land stock: anything
  // this seam has not been taught about is record-only, which under-promises rather than
  // inventing a movement the write cannot perform. Asserting the mode-by-mode answer, not merely
  // that the answer is one of the two, is what would actually catch a new mode defaulting to
  // COUNT.
  it('lands stock for DISCRETE and nothing else, across every declared mode', () => {
    for (const mode of TRACKING_MODES) {
      expect(receiptLandingFor(mode)).toBe(mode === 'DISCRETE' ? 'COUNT' : 'RECORD_ONLY');
    }
  });
});

describe('recordOnlyReceiptReason (issue #608)', () => {
  it('gives every record-only mode its own reason, and none to the mode that moves stock', () => {
    expect(recordOnlyReceiptReason('DISCRETE')).toBeNull();
    for (const mode of TRACKING_MODES.filter((m) => m !== 'DISCRETE')) {
      expect(recordOnlyReceiptReason(mode)).toBeTruthy();
    }
  });

  // The dialogs read "is there a reason?" as "is this receipt record-only?" and render the clause
  // unconditionally on that branch. That is only sound while the two functions agree for every
  // mode, so the agreement is pinned here rather than re-guarded at each call site.
  it('gives a reason exactly when the receipt is record-only', () => {
    for (const mode of TRACKING_MODES) {
      expect(recordOnlyReceiptReason(mode) !== null).toBe(receiptLandingFor(mode) === 'RECORD_ONLY');
    }
  });

  // The catalog carries a second English of every clause, for the screens that render one inside a
  // translated sentence. Two Englishes can drift, so this drives both and compares them: the seam's
  // stored `text` and `en.json`'s value for the same key must be the same words (issue #589).
  it('keeps the catalog copy of each clause identical to the stored English', () => {
    const catalog = EN_CATALOG as Record<string, string | undefined>;
    for (const mode of TRACKING_MODES) {
      const reason = recordOnlyReason(mode);
      if (reason === null) continue;
      expect(catalog[reason.messageKey], `${mode} → ${reason.messageKey}`).toBe(reason.text);
    }
  });

  // Every mode's key must be a distinct one, or two modes would explain themselves the same way in
  // a translated catalog while reading differently in a ledger note.
  it('gives each record-only mode its own catalog key', () => {
    const keys = TRACKING_MODES.map((m) => recordOnlyReason(m)?.messageKey).filter((k) => k !== undefined);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('reads as a clause, so one string serves both the ledger note and the dialogs', () => {
    // "No stock was added: <reason>." and "…no stock is added, because <reason>" must both scan.
    for (const mode of TRACKING_MODES.filter((m) => m !== 'DISCRETE')) {
      const reason = recordOnlyReceiptReason(mode)!;
      expect(reason[0]).toBe(reason[0]!.toLowerCase());
      expect(reason.endsWith('.')).toBe(false);
    }
  });
});
