import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { QrCodeDialog } from './QrCodeDialog';
import { useModulesStore } from '@/state/stores/useModulesStore';

/** A fake `NDEFReader` whose write stays pending so the dialog shows its "writing" state. */
function installFakeReader() {
  const write = vi.fn(() => new Promise<void>(() => {}));
  class FakeReader {
    write = write;
    scan = vi.fn(async () => {});
    addEventListener = vi.fn();
    removeEventListener = vi.fn();
  }
  (globalThis as { NDEFReader?: unknown }).NDEFReader = FakeReader;
  return write;
}

afterEach(() => {
  cleanup();
  delete (globalThis as { NDEFReader?: unknown }).NDEFReader;
  useModulesStore.setState({ intent: {} });
});

const props = {
  open: true,
  onClose: () => {},
  itemId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  itemName: 'Widget',
  itemMpn: null,
};

describe('QrCodeDialog — write to NFC tag (issue #71)', () => {
  it('offers "Write to tag" and arms a url write when NFC is available', () => {
    const write = installFakeReader();
    render(<QrCodeDialog {...props} />);

    const button = screen.getByTestId('nfc-write');
    expect(button).toHaveTextContent('Write to tag');

    fireEvent.click(button);

    // The item's deep-link is written as a single url record.
    expect(write).toHaveBeenCalledTimes(1);
    const [message] = write.mock.calls[0]!;
    expect(message.records[0].recordType).toBe('url');
    expect(message.records[0].data).toContain(props.itemId);

    // The status region announces the tap prompt and the button is now disabled.
    expect(screen.getByTestId('nfc-write-status')).toHaveTextContent(/hold a blank tag/i);
    expect(button).toBeDisabled();
  });

  it('hides the write affordance where Web NFC is unsupported', () => {
    render(<QrCodeDialog {...props} />);
    expect(screen.queryByTestId('nfc-write')).toBeNull();
  });

  it('hides the write affordance when the NFC capability is turned off', () => {
    installFakeReader();
    useModulesStore.setState({ intent: { nfc: false } });
    render(<QrCodeDialog {...props} />);
    expect(screen.queryByTestId('nfc-write')).toBeNull();
  });
});
