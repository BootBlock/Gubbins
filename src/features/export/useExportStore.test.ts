import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_EXPORT_FORMAT,
  DEFAULT_EXPORT_SCOPE,
  DEFAULT_REPORT_EXPORT_KIND,
  EXPORT_FORMATS,
  normaliseExportFormat,
  normaliseReportExportKind,
  useExportStore,
} from './useExportStore';

const state = () => useExportStore.getState();

/** Seed `localStorage` and replay Zustand's rehydration — see `lib/persisted-state`. */
function rehydrateFrom(persisted: unknown): void {
  localStorage.setItem('gubbins:export', JSON.stringify({ state: persisted, version: 0 }));
  void useExportStore.persist.rehydrate();
}

beforeEach(() => {
  localStorage.clear();
  useExportStore.setState({
    format: DEFAULT_EXPORT_FORMAT,
    scope: DEFAULT_EXPORT_SCOPE,
    scopeTargetId: null,
    includeInactive: false,
    reportKind: DEFAULT_REPORT_EXPORT_KIND,
  });
});

describe('normalisers', () => {
  it.each(EXPORT_FORMATS)('keeps the live format %s', (format) => {
    expect(normaliseExportFormat(format)).toBe(format);
  });

  it.each([['XLSX'], [''], [undefined], [null], [{}]])('falls back for %p', (value) => {
    expect(normaliseExportFormat(value)).toBe(DEFAULT_EXPORT_FORMAT);
  });

  it('reconciles a report kind against the live list', () => {
    expect(normaliseReportExportKind('SPEND')).toBe('SPEND');
    expect(normaliseReportExportKind('SHRINKAGE')).toBe(DEFAULT_REPORT_EXPORT_KIND);
  });
});

describe('useExportStore — rehydration', () => {
  it('remembers a fully valid set of last-used settings', () => {
    rehydrateFrom({
      format: 'CSV',
      scope: 'ITEM',
      scopeTargetId: 'item-1',
      includeInactive: true,
      reportKind: 'ABC',
    });
    expect(state().format).toBe('CSV');
    expect(state().scope).toBe('ITEM');
    expect(state().scopeTargetId).toBe('item-1');
    expect(state().includeInactive).toBe(true);
    expect(state().reportKind).toBe('ABC');
  });

  it('does not pre-select a format the wizard can no longer run', () => {
    rehydrateFrom({ format: 'PDF' });
    expect(state().format).toBe(DEFAULT_EXPORT_FORMAT);
  });

  it('does not pre-select a retired scope or report kind', () => {
    rehydrateFrom({ scope: 'CATEGORY', reportKind: 'SHRINKAGE' });
    expect(state().scope).toBe(DEFAULT_EXPORT_SCOPE);
    expect(state().reportKind).toBe(DEFAULT_REPORT_EXPORT_KIND);
  });

  it('drops a target id that the reconciled scope cannot use', () => {
    // The scope fell back to ALL, which never carries a target.
    rehydrateFrom({ scope: 'CATEGORY', scopeTargetId: 'cat-1' });
    expect(state().scope).toBe('ALL');
    expect(state().scopeTargetId).toBeNull();
  });

  it('drops a non-string target id', () => {
    rehydrateFrom({ scope: 'PROJECT', scopeTargetId: 42 });
    expect(state().scope).toBe('PROJECT');
    expect(state().scopeTargetId).toBeNull();
  });

  it('survives a payload that is not an object at all', () => {
    rehydrateFrom(null);
    expect(state().format).toBe(DEFAULT_EXPORT_FORMAT);
    expect(state().scope).toBe(DEFAULT_EXPORT_SCOPE);
    expect(state().reportKind).toBe(DEFAULT_REPORT_EXPORT_KIND);
  });
});

describe('useExportStore — setters', () => {
  it('switching scope drops a now-irrelevant target id', () => {
    state().setScope('ITEM');
    state().setScopeTargetId('item-1');
    state().setScope('PROJECT');
    expect(state().scopeTargetId).toBeNull();
  });

  it('rejects an out-of-union value handed in at runtime', () => {
    state().setFormat('PDF' as never);
    expect(state().format).toBe(DEFAULT_EXPORT_FORMAT);
  });
});
