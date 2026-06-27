import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import { ToastProvider, useToast } from './toast';

afterEach(cleanup);

function Trigger({ duration }: { duration?: number }) {
  const { show } = useToast();
  return (
    <button onClick={() => show({ message: 'Saved', heading: 'Done', duration })}>fire</button>
  );
}

describe('Foundry Toast', () => {
  it('shows a toast on demand and dismisses it manually', () => {
    render(
      <ToastProvider>
        <Trigger duration={0} />
      </ToastProvider>,
    );
    expect(screen.queryByTestId('toast')).toBeNull();
    fireEvent.click(screen.getByText('fire'));
    expect(screen.getByTestId('toast')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Dismiss notification'));
    expect(screen.queryByTestId('toast')).toBeNull();
  });

  it('auto-dismisses after the duration (passive, §4)', async () => {
    vi.useFakeTimers();
    try {
      render(
        <ToastProvider>
          <Trigger duration={3000} />
        </ToastProvider>,
      );
      fireEvent.click(screen.getByText('fire'));
      expect(screen.getByTestId('toast')).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(3000);
      });
      expect(screen.queryByTestId('toast')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders an actionable button (§9.4.3 graceful degradation)', async () => {
    const onClick = vi.fn();
    function ActionTrigger() {
      const { show } = useToast();
      return (
        <button onClick={() => show({ message: 'Scrape failed', action: { label: 'Enter manually', onClick } })}>
          fire
        </button>
      );
    }
    render(
      <ToastProvider>
        <ActionTrigger />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('fire'));
    fireEvent.click(screen.getByText('Enter manually'));
    expect(onClick).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByTestId('toast')).toBeNull());
  });
});
