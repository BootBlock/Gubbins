import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { LiveRegion } from './live-region';

afterEach(cleanup);

describe('LiveRegion — accessible status announcer (WCAG 4.1.3)', () => {
  it('defaults to a polite status region', () => {
    render(<LiveRegion>Saved.</LiveRegion>);
    const region = screen.getByRole('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.getAttribute('aria-atomic')).toBe('true');
    expect(region.textContent).toBe('Saved.');
  });

  it('becomes an assertive alert when urgency=assertive', () => {
    render(<LiveRegion urgency="assertive">Sync failed.</LiveRegion>);
    const region = screen.getByRole('alert');
    expect(region.getAttribute('aria-live')).toBe('assertive');
  });

  it('stays mounted (and announceable) even with no message', () => {
    // The region must pre-exist so a later content change is announced; an empty
    // region is therefore still present in the DOM, just with no text.
    render(<LiveRegion>{null}</LiveRegion>);
    const region = screen.getByRole('status');
    expect(region).toBeTruthy();
    expect(region.textContent).toBe('');
  });

  it('renders announce-only (sr-only) when visuallyHidden', () => {
    render(<LiveRegion visuallyHidden>Scanned Widget.</LiveRegion>);
    const region = screen.getByRole('status');
    expect(region.className).toContain('sr-only');
  });

  it('merges caller className and passes data attributes through', () => {
    render(
      <LiveRegion className="text-sm" data-testid="sync-result-live">
        CLEAN
      </LiveRegion>,
    );
    const region = screen.getByTestId('sync-result-live');
    expect(region.className).toContain('text-sm');
    expect(region.getAttribute('role')).toBe('status');
  });
});
