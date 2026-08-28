/**
 * The Inventory screen's permission gate (issue #429).
 *
 * This screen is the app's densest collection of *bulk* capabilities — import, export, bulk edit,
 * duplicate, label printing and the printable catalogue — each of which a role can be refused
 * independently of plain item reads. The rule the whole gate rests on is that a refused capability
 * is taken off screen rather than disabled, and that no second route (a select-mode button, a
 * dialog left mounted, or an intent raised on another screen) is left able to drive it anyway.
 *
 * Everything the screen actually queries or draws is stubbed: this suite is about which controls
 * are offered to which authority, not about the list, the location tree or any dialog's contents.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useSessionStore } from '@/state/stores/useSessionStore';
import { useModulesStore } from '@/state/stores/useModulesStore';
import { UNRESTRICTED_AUTHORITY } from '@/features/users/permissions';
import { useInventoryEntry } from './useInventoryEntry';
import { InventoryScreen } from './InventoryScreen';

// ─── chrome + navigation ──────────────────────────────────────────────────────

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { to?: string; children?: React.ReactNode }) => (
    <a {...props}>{children}</a>
  ),
}));
vi.mock('@/components/BrandMark', () => ({ BrandMark: () => <span data-testid="brand-mark" /> }));
vi.mock('@/components/BrandTagline', () => ({ BrandTagline: () => <span /> }));
vi.mock('@/components/nav/AppNav', () => ({ AppNav: () => <nav data-testid="app-nav" /> }));
vi.mock('@/features/command-palette/HeaderSearch', () => ({ HeaderSearch: () => <div /> }));

// ─── reads: nothing here exercises the database ───────────────────────────────

const emptyList = {
  data: { pages: [{ rows: [], offset: 0 }] },
  isLoading: false,
  isError: false,
  isSuccess: true,
  hasNextPage: false,
  hasPreviousPage: false,
  isFetchingNextPage: false,
  isFetchingPreviousPage: false,
  fetchNextPage: vi.fn(),
  fetchPreviousPage: vi.fn(),
  refetch: vi.fn(),
};

vi.mock('./queries', () => ({
  useInventoryItems: () => emptyList,
  useItemPage: () => ({ data: { rows: [] }, isLoading: false, isError: false, isSuccess: true }),
  useItemCount: () => ({ data: 0, isSuccess: true }),
  useItem: () => ({ data: undefined }),
  useLocations: () => ({ data: { rows: [] } }),
  useLocationTree: () => ({ data: [] }),
  useApplicableStatuses: () => ({ data: undefined }),
}));
vi.mock('@/features/search/queries', () => ({
  astError: () => null,
  astLocationScope: () => null,
  useAstSearch: () => emptyList,
  useAstCount: () => ({ data: 0, isSuccess: true }),
}));
vi.mock('./categories', () => ({ useItemFieldValues: () => ({ data: undefined }) }));
vi.mock('./tags', () => ({ useItemsTags: () => ({ data: undefined }) }));
vi.mock('./components/useCardFieldsConfig', () => ({
  useCardFieldsConfig: () => ({
    order: [],
    customFields: new Map(),
    categoryName: new Map(),
    categoryGlyph: new Map(),
    visibleCustomFieldIds: [],
    hasTagsField: false,
  }),
}));
vi.mock('./mutations', () => ({ useCloneItem: () => ({ mutateAsync: vi.fn(), isPending: false }) }));
vi.mock('./useUndoToast', () => ({ useUndoToast: () => vi.fn() }));
vi.mock('@/features/reports/useCatalogueLaunch', () => ({
  useCatalogueLaunch: { getState: () => ({ launch: vi.fn() }) },
}));
vi.mock('@/features/hotkeys/useHotkeyScope', () => ({ useHotkeyScope: () => undefined }));

// ─── the heavy children, each reduced to a marker ─────────────────────────────

vi.mock('./item-drag', () => ({
  ItemDragProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));
vi.mock('./components/LocationSidebar', () => ({ LocationSidebar: () => <aside /> }));
vi.mock('./components/ItemList', () => ({ ItemList: () => <div data-testid="item-list" /> }));
vi.mock('./components/GroupedItemList', () => ({ GroupedItemList: () => <div /> }));
vi.mock('./components/LocationMapView', () => ({ LocationMapView: () => <div /> }));
vi.mock('./components/ValueTreemapView', () => ({ ValueTreemapView: () => <div /> }));
vi.mock('./components/InventoryFilterBar', () => ({ InventoryFilterBar: () => <div /> }));
vi.mock('./components/InventoryFacetBar', () => ({ InventoryFacetBar: () => <div /> }));
vi.mock('./components/LocationInfoCard', () => ({ LocationInfoCard: () => <div /> }));
vi.mock('./components/LocationDetailCard', () => ({ LocationDetailCard: () => <div /> }));
vi.mock('./components/CreateItemDialog', () => ({ CreateItemDialog: () => <div /> }));
vi.mock('./components/CategoryManagerDialog', () => ({ CategoryManagerDialog: () => <div /> }));
vi.mock('./components/ItemDetailDialog', () => ({ ItemDetailDialog: () => <div /> }));
vi.mock('@/features/lifecycle/components/AuditDayDialog', () => ({ AuditDayDialog: () => <div /> }));
vi.mock('@/features/lifecycle/components/CycleCountDialog', () => ({ CycleCountDialog: () => <div /> }));
vi.mock('@/features/search/components/VisualBuilder', () => ({ VisualBuilder: () => <div /> }));
vi.mock('@/features/search/components/SavedSearchMenu', () => ({ SavedSearchMenu: () => <div /> }));

// The four gated dialogs report whether they are mounted *and* open, so a test can tell "the
// button is gone" apart from "the dialog behind it is still live".
const openMarker = vi.hoisted(
  () => (testId: string) =>
    function Marker({ open }: { open?: boolean }) {
      return open ? <div data-testid={testId} /> : null;
    },
);
vi.mock('./components/ImportDataDialog', () => ({ ImportDataDialog: openMarker('import-dialog') }));
vi.mock('@/features/export/ExportWizard', () => ({ ExportWizard: openMarker('export-wizard') }));
vi.mock('./components/PrintLabelsDialog', () => ({ PrintLabelsDialog: openMarker('print-labels-dialog') }));
vi.mock('./components/BulkEditDialog', () => ({ BulkEditDialog: openMarker('bulk-edit-dialog') }));
// The scanner overlay reports the same way: a `scan` intent that slipped past the capability
// gate would mount it *open*, which is exactly what issue #636 was.
vi.mock('@/features/scanner/components/ScannerOverlay', () => ({
  ScannerOverlay: openMarker('scanner-overlay'),
}));

// ─── harness ──────────────────────────────────────────────────────────────────

/** Grant exactly these keys — anything absent is refused. */
function grant(...keys: string[]) {
  useSessionStore.setState({ authority: { mode: 'granted', grants: new Set(keys) } });
}

/** Open the header's "More" menu and enter select mode, revealing the selection bar. */
async function enterSelectMode(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'More inventory actions' }));
  await user.click(screen.getByTestId('toggle-select'));
}

// The rest of the suite (and every other screen test) runs as single-user mode does —
// unrestricted — so the authority is restored on both edges rather than only before, or a
// restricted case here would leak its grants into whatever ran next.
beforeEach(() => useSessionStore.setState({ authority: UNRESTRICTED_AUTHORITY }));
afterEach(() => {
  cleanup();
  useInventoryEntry.setState({ pendingIntent: null });
  useSessionStore.setState({ authority: UNRESTRICTED_AUTHORITY });
  useModulesStore.setState({ intent: {} });
});

describe('InventoryScreen — an unrestricted session', () => {
  it('offers every gated control', async () => {
    const user = userEvent.setup();
    render(<InventoryScreen />);

    // Import hangs off the Add-item split button's chevron.
    await user.click(screen.getByTestId('inventory-add-menu'));
    expect(screen.getByTestId('open-catalog-import')).toBeInTheDocument();
    await user.keyboard('{Escape}');

    await enterSelectMode(user);
    expect(screen.getByTestId('bulk-edit')).toBeInTheDocument();
    expect(screen.getByTestId('duplicate-item')).toBeInTheDocument();
    expect(screen.getByTestId('print-catalogue')).toBeInTheDocument();
    expect(screen.getByTestId('print-labels')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'More inventory actions' }));
    expect(screen.getByTestId('open-export-wizard')).toBeInTheDocument();
  });
});

describe('InventoryScreen — a session holding only items:read', () => {
  beforeEach(() => grant('items:read'));

  it('offers no chevron on Add item, because Import is its only entry', () => {
    render(<InventoryScreen />);

    expect(screen.getByTestId('inventory-add-item')).toBeInTheDocument();
    expect(screen.queryByTestId('inventory-add-menu')).not.toBeInTheDocument();
  });

  it('drops Export from the More menu', async () => {
    const user = userEvent.setup();
    render(<InventoryScreen />);

    await user.click(screen.getByRole('button', { name: 'More inventory actions' }));
    // The menu itself still has plenty to offer, so only the one row goes.
    expect(screen.getByTestId('toggle-select')).toBeInTheDocument();
    expect(screen.queryByTestId('open-export-wizard')).not.toBeInTheDocument();
  });

  it('hides bulk edit, duplicate, the catalogue and label printing from the selection bar', async () => {
    const user = userEvent.setup();
    render(<InventoryScreen />);

    await enterSelectMode(user);
    expect(screen.getByTestId('selection-bar')).toBeInTheDocument();
    expect(screen.queryByTestId('bulk-edit')).not.toBeInTheDocument();
    expect(screen.queryByTestId('duplicate-item')).not.toBeInTheDocument();
    expect(screen.queryByTestId('print-catalogue')).not.toBeInTheDocument();
    expect(screen.queryByTestId('print-labels')).not.toBeInTheDocument();
  });
});

describe('InventoryScreen — items:write', () => {
  it('brings back bulk edit and duplicate, and nothing else', async () => {
    const user = userEvent.setup();
    grant('items:read', 'items:write');
    render(<InventoryScreen />);

    await enterSelectMode(user);
    expect(screen.getByTestId('bulk-edit')).toBeInTheDocument();
    expect(screen.getByTestId('duplicate-item')).toBeInTheDocument();
    // The bulk capabilities are separately grantable, so writing items buys none of them.
    expect(screen.queryByTestId('print-labels')).not.toBeInTheDocument();
    expect(screen.queryByTestId('print-catalogue')).not.toBeInTheDocument();
  });
});

describe('InventoryScreen — labels:print and reports:read', () => {
  it('offers Print labels to labels:print and the catalogue to reports:read', async () => {
    const user = userEvent.setup();
    grant('items:read', 'labels:print', 'reports:read');
    render(<InventoryScreen />);

    await enterSelectMode(user);
    expect(screen.getByTestId('print-labels')).toBeInTheDocument();
    expect(screen.getByTestId('print-catalogue')).toBeInTheDocument();
    expect(screen.queryByTestId('bulk-edit')).not.toBeInTheDocument();
  });
});

describe('InventoryScreen — a scan intent raised elsewhere', () => {
  it('opens the scanner overlay while the Scanner capability is on', () => {
    useInventoryEntry.setState({ pendingIntent: 'scan' });
    render(<InventoryScreen />);

    expect(screen.getByTestId('scanner-overlay')).toBeInTheDocument();
    expect(useInventoryEntry.getState().pendingIntent).toBeNull();
  });

  it('refuses the intent — and still clears it — with Scanner switched off (#636)', () => {
    useModulesStore.getState().setFeatureIntent('scanner', false);
    useInventoryEntry.setState({ pendingIntent: 'scan' });
    render(<InventoryScreen />);

    // Any caller can raise the intent, so the camera must stay shut here too — not only at
    // whichever entry points remembered to check.
    expect(screen.queryByTestId('scanner-overlay')).not.toBeInTheDocument();
    expect(useInventoryEntry.getState().pendingIntent).toBeNull();
  });
});

describe('InventoryScreen — an import intent raised elsewhere', () => {
  it('opens the import dialog when the session holds import:run', () => {
    useInventoryEntry.setState({ pendingIntent: 'import' });
    grant('items:read', 'import:run');
    render(<InventoryScreen />);

    expect(screen.getByTestId('import-dialog')).toBeInTheDocument();
    expect(useInventoryEntry.getState().pendingIntent).toBeNull();
  });

  it('refuses the intent — and still clears it — without import:run', () => {
    useInventoryEntry.setState({ pendingIntent: 'import' });
    grant('items:read');
    render(<InventoryScreen />);

    // The hidden chevron would be worthless if the dashboard could still drive the dialog.
    expect(screen.queryByTestId('import-dialog')).not.toBeInTheDocument();
    // Cleared regardless, or it would re-fire the next time this screen mounted.
    expect(useInventoryEntry.getState().pendingIntent).toBeNull();
  });
});
