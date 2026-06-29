import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { SkipLink, MAIN_CONTENT_ID } from './skip-link';

afterEach(cleanup);

describe('SkipLink — accessible bypass (spec §2.4.1)', () => {
  it('renders a link pointing at the main-content landmark', () => {
    render(<SkipLink />);
    const link = screen.getByRole('link', { name: 'Skip to content' });
    expect(link.getAttribute('href')).toBe(`#${MAIN_CONTENT_ID}`);
  });

  it('moves focus to the #main-content landmark on activation', () => {
    render(
      <>
        <SkipLink />
        <main id={MAIN_CONTENT_ID} tabIndex={-1}>
          content
        </main>
      </>,
    );
    const link = screen.getByRole('link', { name: 'Skip to content' });
    fireEvent.click(link);
    expect(document.activeElement).toBe(screen.getByRole('main'));
  });

  it('is a no-op when the landmark is absent (no throw)', () => {
    render(<SkipLink />);
    const link = screen.getByRole('link', { name: 'Skip to content' });
    expect(() => fireEvent.click(link)).not.toThrow();
  });
});
