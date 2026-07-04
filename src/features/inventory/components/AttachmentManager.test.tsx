import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { ItemAttachment } from '@/db/repositories';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';

/**
 * Behaviour tests for the {@link AttachmentManager} glue (spec §4 "Attachments & Datasheets",
 * Phase 53). The foreign-vs-local decision lives in the pure `resolveAttachmentLink` seam
 * (covered by attachment-link.test.ts) and is used here for real; this pins the *manager's*
 * contract — how the add form assembles its `CreateAttachmentInput` under each `attachmentMode`,
 * how a resolved link chooses its row presentation (URL anchor / local path / "Unlinked Local
 * File"), and the unlinked-row re-home flows (Re-link / Use URL) that assemble the
 * `UpdateAttachmentInput`. Per the component-test conventions the `../media` hooks and
 * `getDeviceId` are mocked (the preferences store runs for real); the pure seam is not.
 */

const THIS_DEVICE = 'this-device';

const h = vi.hoisted(() => ({
  attachments: [] as ItemAttachment[],
  addAttachment: vi.fn(),
  removeAttachment: vi.fn(),
  updateAttachment: vi.fn(),
}));

vi.mock('@/lib/env/device-id', () => ({
  getDeviceId: () => 'this-device',
}));

vi.mock('../media', () => ({
  useItemAttachments: () => ({ data: h.attachments }),
  useAddAttachment: () => ({ mutate: h.addAttachment, isPending: false }),
  useRemoveAttachment: () => ({ mutate: h.removeAttachment, isPending: false }),
  useUpdateAttachment: () => ({ mutate: h.updateAttachment, isPending: false }),
}));

import { AttachmentManager } from './AttachmentManager';

const ITEM_ID = 'item-1';

/** Synthetic, COMPLETE attachment fixture (tests are excluded from tsc). */
const attachment = (overrides: Partial<ItemAttachment> = {}): ItemAttachment => ({
  id: 'att-1',
  itemId: ITEM_ID,
  kind: 'URL',
  value: 'https://example.test/datasheet.pdf',
  label: null,
  position: 0,
  originDeviceId: null,
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
});

function renderManager() {
  return render(<AttachmentManager itemId={ITEM_ID} />);
}

beforeEach(() => {
  h.attachments = [];
  h.addAttachment.mockReset().mockImplementation((_input, opts) => opts?.onSuccess?.());
  h.removeAttachment.mockReset();
  h.updateAttachment.mockReset().mockImplementation((_input, opts) => opts?.onSuccess?.());
  usePreferencesStore.setState({ attachmentMode: 'URL_ONLY' });
});
afterEach(cleanup);

describe('AttachmentManager — URL_ONLY mode add form', () => {
  it('hides the kind Select and adds a URL with a null origin, clearing on success', async () => {
    renderManager();
    // In URL_ONLY the kind chooser is not rendered — the kind is forced to URL.
    expect(screen.queryByRole('combobox', { name: 'Attachment kind' })).not.toBeInTheDocument();

    const location = screen.getByLabelText('Attachment location');
    const label = screen.getByLabelText('Attachment label');
    const link = screen.getByRole('button', { name: /Link datasheet/ });

    // Disabled until a non-blank location is entered.
    expect(link).toBeDisabled();
    fireEvent.change(location, { target: { value: 'https://example.test/ne555.pdf' } });
    fireEvent.change(label, { target: { value: 'NE555 datasheet' } });
    expect(link).toBeEnabled();
    fireEvent.click(link);

    await waitFor(() =>
      expect(h.addAttachment).toHaveBeenCalledWith(
        {
          itemId: ITEM_ID,
          kind: 'URL',
          value: 'https://example.test/ne555.pdf',
          label: 'NE555 datasheet',
          originDeviceId: null,
        },
        expect.anything(),
      ),
    );
    // The value and label inputs clear on success.
    expect(location).toHaveValue('');
    expect(label).toHaveValue('');
  });

  it('trims a blank label to null', async () => {
    renderManager();
    fireEvent.change(screen.getByLabelText('Attachment location'), {
      target: { value: 'https://example.test/a.pdf' },
    });
    fireEvent.change(screen.getByLabelText('Attachment label'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: /Link datasheet/ }));

    await waitFor(() =>
      expect(h.addAttachment).toHaveBeenCalledWith(
        expect.objectContaining({ label: null }),
        expect.anything(),
      ),
    );
  });

  it('surfaces a failed add in an alert without clearing the inputs', async () => {
    h.addAttachment.mockImplementation((_input, opts) =>
      opts?.onError?.(new Error('That URL is not valid.')),
    );
    renderManager();
    const location = screen.getByLabelText('Attachment location');
    fireEvent.change(location, { target: { value: 'not-a-url' } });
    fireEvent.click(screen.getByRole('button', { name: /Link datasheet/ }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('That URL is not valid.'));
    expect(location).toHaveValue('not-a-url');
  });
});

describe('AttachmentManager — HYBRID mode add form', () => {
  beforeEach(() => {
    usePreferencesStore.setState({ attachmentMode: 'HYBRID' });
  });

  it('choosing Local file adds a LOCAL_POINTER stamped with this device', async () => {
    renderManager();
    // Foundry Select is a custom listbox — open it and click the option (not selectOption).
    fireEvent.click(screen.getByRole('combobox', { name: 'Attachment kind' }));
    fireEvent.click(screen.getByRole('option', { name: 'Local file' }));

    fireEvent.change(screen.getByLabelText('Attachment location'), {
      target: { value: 'C:\\Datasheets\\NE555.pdf' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Link datasheet/ }));

    await waitFor(() =>
      expect(h.addAttachment).toHaveBeenCalledWith(
        {
          itemId: ITEM_ID,
          kind: 'LOCAL_POINTER',
          value: 'C:\\Datasheets\\NE555.pdf',
          label: null,
          originDeviceId: THIS_DEVICE,
        },
        expect.anything(),
      ),
    );
  });

  it('leaving the kind at URL adds with a null origin', async () => {
    renderManager();
    // The Select defaults to URL — no interaction needed.
    fireEvent.change(screen.getByLabelText('Attachment location'), {
      target: { value: 'https://example.test/b.pdf' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Link datasheet/ }));

    await waitFor(() =>
      expect(h.addAttachment).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'URL', originDeviceId: null }),
        expect.anything(),
      ),
    );
  });
});

describe('AttachmentManager — resolved row presentation', () => {
  it('shows the empty prompt when there are no attachments', () => {
    renderManager();
    expect(screen.getByText('No datasheets linked yet.')).toBeInTheDocument();
  });

  it('renders a URL attachment as an anchor to its value', () => {
    h.attachments = [
      attachment({ id: 'url-1', kind: 'URL', value: 'https://example.test/sheet.pdf', label: 'Sheet' }),
    ];
    renderManager();
    const anchor = screen.getByRole('link', { name: 'Sheet' });
    expect(anchor).toHaveAttribute('href', 'https://example.test/sheet.pdf');
    expect(screen.queryByTestId('attachment-unlinked')).not.toBeInTheDocument();
  });

  it('renders an own-device local pointer with its path, not the unlinked placeholder', () => {
    h.attachments = [
      attachment({
        id: 'loc-1',
        kind: 'LOCAL_POINTER',
        value: '/home/me/local.pdf',
        originDeviceId: THIS_DEVICE,
      }),
    ];
    renderManager();
    expect(screen.getByText('/home/me/local.pdf')).toBeInTheDocument();
    expect(screen.queryByTestId('attachment-unlinked')).not.toBeInTheDocument();
  });

  it('degrades a FOREIGN local pointer to the Unlinked Local File row', () => {
    h.attachments = [
      attachment({
        id: 'loc-2',
        kind: 'LOCAL_POINTER',
        value: '/other/device/local.pdf',
        originDeviceId: 'another-device',
      }),
    ];
    renderManager();
    expect(screen.getByTestId('attachment-unlinked')).toBeInTheDocument();
    expect(screen.getByText('Unlinked Local File')).toBeInTheDocument();
  });
});

describe('AttachmentManager — removing a row', () => {
  it('removes a URL row with just its id', () => {
    h.attachments = [attachment({ id: 'url-9' })];
    renderManager();
    fireEvent.click(screen.getByRole('button', { name: 'Remove attachment' }));
    expect(h.removeAttachment).toHaveBeenCalledWith('url-9');
  });
});

describe('AttachmentManager — unlinked-row re-home flows', () => {
  beforeEach(() => {
    h.attachments = [
      attachment({
        id: 'unlinked-1',
        kind: 'LOCAL_POINTER',
        value: '/foreign/path.pdf',
        originDeviceId: 'another-device',
      }),
    ];
  });

  it('Use URL → updates with kind URL, the typed value and a null origin', async () => {
    renderManager();
    fireEvent.click(screen.getByTestId('attachment-use-url'));

    const input = screen.getByTestId('attachment-relink-input');
    expect(input).toHaveAttribute('aria-label', 'Replacement URL');
    const confirm = screen.getByTestId('attachment-relink-confirm');
    expect(confirm).toBeDisabled();

    fireEvent.change(input, { target: { value: 'https://example.test/rehomed.pdf' } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(h.updateAttachment).toHaveBeenCalledWith(
        {
          id: 'unlinked-1',
          input: { kind: 'URL', value: 'https://example.test/rehomed.pdf', originDeviceId: null },
        },
        expect.anything(),
      ),
    );
  });

  it('Re-link → updates with the typed path and this device as the origin', async () => {
    renderManager();
    fireEvent.click(screen.getByTestId('attachment-relink'));

    const input = screen.getByTestId('attachment-relink-input');
    expect(input).toHaveAttribute('aria-label', 'New local path');
    fireEvent.change(input, { target: { value: '/home/me/rehomed.pdf' } });
    fireEvent.click(screen.getByTestId('attachment-relink-confirm'));

    await waitFor(() =>
      expect(h.updateAttachment).toHaveBeenCalledWith(
        {
          id: 'unlinked-1',
          input: { value: '/home/me/rehomed.pdf', originDeviceId: THIS_DEVICE },
        },
        expect.anything(),
      ),
    );
  });

  it('surfaces a failed re-home in an alert on the row', async () => {
    h.updateAttachment.mockImplementation((_input, opts) =>
      opts?.onError?.(new Error('That path could not be linked.')),
    );
    renderManager();
    fireEvent.click(screen.getByTestId('attachment-relink'));
    fireEvent.change(screen.getByTestId('attachment-relink-input'), {
      target: { value: '/home/me/x.pdf' },
    });
    fireEvent.click(screen.getByTestId('attachment-relink-confirm'));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('That path could not be linked.'),
    );
  });
});
