import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { PageContainer } from './page-container';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';

afterEach(() => {
  cleanup();
  // The full-width layout is a store-read; reset it so it can't leak between cases.
  usePreferencesStore.setState({ fullWidth: false });
});

describe('PageContainer — the canonical page frame (spec §2.4.2)', () => {
  it('centres content at the one shared width with a consistent top offset', () => {
    render(
      <PageContainer>
        <span data-testid="child">content</span>
      </PageContainer>,
    );
    const frame = screen.getByTestId('child').parentElement;
    // The fixed frame — identical on every screen so the header never shifts.
    expect(frame?.className).toContain('mx-auto');
    expect(frame?.className).toContain('max-w-6xl');
    // Both offsets carry the device's safe-area inset, so the frame starts clear of a notch
    // or a rounded corner rather than under it (issue #655). Matched as whole class names:
    // `px-safe-gutter-x` is a prefix of the large-format `px-safe-gutter-x-lg`, so a substring
    // check would still pass with the base gutter deleted — i.e. on the phones this is for.
    expect(frame?.className.split(' ')).toContain('px-safe-gutter-x');
    expect(frame?.className.split(' ')).toContain('pt-safe-page-top');
  });

  it('grows with content by default (min-h-dvh, gapped sections)', () => {
    render(
      <PageContainer>
        <span data-testid="child">content</span>
      </PageContainer>,
    );
    const frame = screen.getByTestId('child').parentElement;
    expect(frame?.className).toContain('min-h-dvh');
    expect(frame?.className).toContain('gap-6');
  });

  it('pins to the viewport height in the full-height variant, without a section gap', () => {
    render(
      <PageContainer fullHeight>
        <span data-testid="child">content</span>
      </PageContainer>,
    );
    const frame = screen.getByTestId('child').parentElement;
    expect(frame?.className).toContain('h-dvh');
    expect(frame?.className).not.toContain('min-h-dvh');
    expect(frame?.className).not.toContain('gap-6');
    // Same top offset as the default — the header Y never moves between screens.
    expect(frame?.className.split(' ')).toContain('pt-safe-page-top');
  });

  it('drops the centred width cap when Full width is on (issue #14)', () => {
    usePreferencesStore.setState({ fullWidth: true });
    render(
      <PageContainer>
        <span data-testid="child">content</span>
      </PageContainer>,
    );
    const frame = screen.getByTestId('child').parentElement;
    // The centred cap (and the large-format ceiling) give way to a full-width frame; the
    // horizontal padding stays so content never touches the viewport edge.
    expect(frame?.className).toContain('max-w-none');
    expect(frame?.className).not.toContain('max-w-6xl');
    expect(frame?.className.split(' ')).toContain('px-safe-gutter-x');
  });

  it('merges extra classes onto the frame', () => {
    render(
      <PageContainer className="relative isolate">
        <span data-testid="child">content</span>
      </PageContainer>,
    );
    const frame = screen.getByTestId('child').parentElement;
    expect(frame?.className).toContain('relative');
    expect(frame?.className).toContain('isolate');
  });
});
