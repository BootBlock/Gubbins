import { describe, it, expect } from 'vitest';
import { alertsExportColumns, alertsExportFilename, buildAlertsExport } from './alerts-export';
import type { Alert } from './alerts';

function alert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: 'low-stock:widget-1',
    kind: 'low-stock',
    severity: 'warning',
    title: 'Low stock — Brass widget',
    detail: 'This item is at or below its reorder point.',
    dueAt: null,
    target: { route: '/inventory', itemId: 'widget-1', itemName: 'Brass widget' },
    ...overrides,
  };
}

function cells(row: Alert): Record<string, unknown> {
  return Object.fromEntries(alertsExportColumns().map((c) => [c.header, c.value(row)]));
}

describe('alertsExportColumns', () => {
  it('flattens the card into its lane, urgency and copy', () => {
    expect(cells(alert())).toEqual({
      Kind: 'Low stock',
      Severity: 'Warning',
      Alert: 'Low stock — Brass widget',
      Detail: 'This item is at or below its reorder point.',
      Due: null,
      Item: 'Brass widget',
    });
  });

  it('names every lane as the screen’s section headings do', () => {
    expect(cells(alert({ kind: 'expiry' })).Kind).toBe('Expiring stock');
    expect(cells(alert({ kind: 'maintenance-due' })).Kind).toBe('Maintenance due');
    expect(cells(alert({ kind: 'warranty-due' })).Kind).toBe('Warranty');
  });

  it('names every severity as the badge does', () => {
    expect(cells(alert({ severity: 'critical' })).Severity).toBe('Critical');
    expect(cells(alert({ severity: 'info' })).Severity).toBe('Info');
  });

  it('carries the due date verbatim — already the locale-independent form the feed sorts on', () => {
    expect(cells(alert({ dueAt: '2026-08-01T00:00:00.000Z' })).Due).toBe('2026-08-01T00:00:00.000Z');
  });

  it('leaves the item blank for an alert that names none', () => {
    expect(cells(alert({ target: { route: '/inventory' } })).Item).toBeNull();
  });

  it('omits the deep-link route, which means nothing outside the app', () => {
    expect(alertsExportColumns().map((c) => c.header)).not.toContain('Route');
  });
});

describe('buildAlertsExport', () => {
  it('serialises the alerts it is given, in the order given', async () => {
    const { content } = await buildAlertsExport('csv', [
      alert(),
      alert({ id: 'expiry:milk', kind: 'expiry', title: 'Expiring — Milk' }),
    ]);
    const lines = String(content).split('\r\n');
    expect(lines[0]).toBe('Kind,Severity,Alert,Detail,Due,Item');
    expect(lines[1]).toContain('Low stock');
    expect(lines[2]).toContain('Expiring stock');
  });

  it('captions a single alert in the singular', async () => {
    const { content } = await buildAlertsExport('html', [alert()]);
    expect(String(content)).toContain('1 alert<');
  });
});

describe('alertsExportFilename', () => {
  it('is date-stamped and carries the chosen extension', () => {
    expect(alertsExportFilename('csv', new Date('2026-07-25T00:00:00Z'))).toBe(
      'gubbins-alerts-2026-07-25.csv',
    );
  });
});
