import { describe, it, expect, afterEach } from 'vitest';
import { useDashboardCustomise } from './useDashboardCustomise';

afterEach(() => useDashboardCustomise.setState({ editing: false }));

describe('useDashboardCustomise', () => {
  it('defaults to not editing', () => {
    expect(useDashboardCustomise.getState().editing).toBe(false);
  });

  it('toggles and sets the shared edit mode', () => {
    useDashboardCustomise.getState().toggle();
    expect(useDashboardCustomise.getState().editing).toBe(true);
    useDashboardCustomise.getState().toggle();
    expect(useDashboardCustomise.getState().editing).toBe(false);
    useDashboardCustomise.getState().setEditing(true);
    expect(useDashboardCustomise.getState().editing).toBe(true);
  });
});
