import { describe, it, expect } from 'vitest';
import {
  REPLACE_CONFIRM_WORD,
  assessQuota,
  assessRestoreImpact,
  estimateBackupBytes,
  isReplaceConfirmed,
} from './restore-safety';

describe('isReplaceConfirmed', () => {
  it('matches the confirm word ignoring case and surrounding space', () => {
    expect(isReplaceConfirmed(REPLACE_CONFIRM_WORD)).toBe(true);
    expect(isReplaceConfirmed('  replace ')).toBe(true);
    expect(isReplaceConfirmed('REPLACE!')).toBe(false);
    expect(isReplaceConfirmed('')).toBe(false);
  });
});

describe('assessRestoreImpact', () => {
  it('flags an empty backup', () => {
    expect(assessRestoreImpact(10, 0)).toMatchObject({ empty: true, shrinking: true });
  });
  it('flags a shrink but not an empty when the backup is smaller', () => {
    expect(assessRestoreImpact(10, 3)).toMatchObject({ empty: false, shrinking: true });
  });
  it('flags neither when the backup is the same size or larger', () => {
    expect(assessRestoreImpact(10, 10)).toMatchObject({ empty: false, shrinking: false });
    expect(assessRestoreImpact(10, 25)).toMatchObject({ empty: false, shrinking: false });
  });
});

describe('estimateBackupBytes', () => {
  it('sums the sqlite copy and the image bytes', () => {
    const bytes = estimateBackupBytes({
      sqlite: new Uint8Array(100),
      images: [{ name: 'a', bytes: new Uint8Array(10) }, { name: 'b', bytes: new Uint8Array(5) }],
    });
    expect(bytes).toBe(115);
  });
  it('is zero for a snapshot-only backup', () => {
    expect(estimateBackupBytes({ sqlite: null, images: [] })).toBe(0);
  });
});

describe('assessQuota', () => {
  it('reports a fit when the payload is within head-room', () => {
    const q = assessQuota(50, 100, 1000, true);
    expect(q).toMatchObject({ known: true, willFit: true, availableBytes: 900 });
  });
  it('reports it will not fit when the payload exceeds head-room', () => {
    expect(assessQuota(950, 100, 1000, true).willFit).toBe(false);
  });
  it('never warns when the estimate is unavailable', () => {
    expect(assessQuota(9_999, 0, 0, false)).toMatchObject({ known: false, willFit: true });
  });
});
