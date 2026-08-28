import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { assertExhaustive } from '@/lib/exhaustive';
import {
  Button,
  buttonVariants,
  Checkbox,
  FormField,
  InfoHint,
  Input,
  LiveRegion,
  Modal,
  Money,
  PageContainer,
  PageHeader,
  Pagination,
  SelectField,
  Spinner,
  Surface,
  Textarea,
  MAIN_CONTENT_ID,
  clampPage,
  pageCount,
  type SelectOption,
} from '@/components/foundry';
import { CatalogueIcon, ChevronDownIcon, DeleteIcon, PrintIcon, UploadIcon } from '@/components/icons';
import type { Formatters } from '@/lib/format';
import { plural } from '@/lib/plural';
import { useFormatters } from '@/lib/useFormatters';
import { useEnabledFeatures } from '@/features/modules/useFeature';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { logoToDataUrl } from './catalogue-branding';
import { buildCataloguePageStyle } from './catalogue-print';
import {
  CONDITION_COLOR_CLASS,
  CONDITION_LABELS,
  WARRANTY_STATUS_COLOR_CLASS,
  WARRANTY_STATUS_LABEL,
} from '@/features/inventory/components/inventory-ui';
import { Thumbnail } from '@/features/inventory/components/Thumbnail';
import { qrSvgOrNull } from '@/features/scanner/qr-code';
import { useT } from '@/features/i18n';
import { buildItemQrUrl, resolveLabelBaseUrl } from '@/features/scanner/scan-payload';
import { useLocations } from '@/features/inventory/queries';
import { useProjects } from '@/features/projects/projects';
import { flattenLocationHierarchy } from './insurance-schedule';
import {
  CATALOGUE_CONFIRM_PAGES,
  CATALOGUE_FIELDS,
  CATALOGUE_GROUP_BY,
  CATALOGUE_SORT_BY,
  DEFAULT_CATALOGUE_FIELDS,
  DEFAULT_CATALOGUE_GROUP_BY,
  DEFAULT_CATALOGUE_SORT_BY,
  cataloguePrintLimit,
  estimateCataloguePages,
  type CatalogueFieldKey,
  type CatalogueGroupBy,
  type CatalogueGroupSummary,
  type CatalogueLine,
  type CatalogueScope,
  type CatalogueSortBy,
  type PartsCatalogueSummary,
} from './parts-catalogue';
import { PAGE_SIZE_BOUNDS, PAGE_SIZE_PRESETS } from '@/features/settings/settings';
import { loadFullCatalogueLines, usePartsCatalogueSummary, usePartsCataloguePage } from './queries';
import { useCatalogueLaunch } from './useCatalogueLaunch';

/** Render context threaded to {@link renderField} — the formatters plus the per-item QR SVGs. */
interface RenderCtx {
  readonly f: Formatters;
  /** Pre-rendered QR SVG per line id when the QR column is on, else null. */
  readonly qrByLine: ReadonlyMap<string, string> | null;
}

/** One section's share of the current page, as the paged read returns it. */
interface CataloguePageSlice {
  readonly groupId: string | null;
  readonly lines: readonly CatalogueLine[];
}

/**
 * Stable empty page, so "no page yet" is the same array on every render.
 *
 * A fresh `[]` in the `??` fallback would re-key the memo that encodes the page's QR codes on
 * every render, which is exactly the per-line cost this screen exists to bound.
 */
const NO_SLICES: readonly CataloguePageSlice[] = [];

/** Which family of items the catalogue is built from — the reader's top-level scope choice. */
type ScopeKind = 'all' | 'location' | 'project' | 'selection';

/** The letterhead/branding a company can stamp onto the printed catalogue (from preferences). */
interface CatalogueBranding {
  readonly title: string;
  readonly orgName: string;
  readonly orgDetails: string;
  readonly footer: string;
  readonly logo: string;
  readonly showGeneratedDate: boolean;
}

// Rich-Markdown help surfaced through the Foundry `hint` badge on each control.
const SHOW_HINT =
  'Choose which items the catalogue lists:\n\n' +
  '- **All items** — your whole active inventory.\n' +
  '- **By location** — a location *and everything nested inside it*.\n' +
  "- **By project** — every item on a project's bill of materials.\n" +
  '- **Selected items** — the items you ticked in the inventory.';
const LOCATION_HINT =
  'Includes the chosen location **and every sub-location beneath it** — so a catalogue for a room also covers its shelves and bins.';
const PROJECT_HINT =
  "Lists every item on this project's **bill of materials** — the parts the project needs, wherever they are stored.";
const COLUMNS_HINT =
  'Pick the columns to print. The item **name** always shows, and each column has its own note on when it is worth including. Turn on **Line value** to total each location and the whole catalogue.';
const LOGO_HINT =
  'An optional graphic printed at the top of the catalogue. Stored on this device only and shrunk automatically. **Add one** for an on-brand, customer-ready print; skip it for an internal working list.';
const ORG_NAME_HINT =
  'Your company or organisation name, printed as the letterhead heading. **Set it** for an official or shared catalogue; leave it blank for a plain internal print.';
const ORG_DETAILS_HINT =
  'Address or contact details printed under the name. **Line breaks are kept** as you type them, so you can lay the address out over several lines. Handy on a catalogue you send out; unnecessary for your own use.';
const TITLE_HINT =
  'Overrides the printed document title (the default is "Catalogue"). **Rename it** to suit the audience — e.g. "Spare Parts List" or "Asset Register".';
const FOOTER_HINT =
  'A line printed at the foot of the catalogue — e.g. a confidentiality or copyright notice. Leave blank for no footer.';
const SHOW_DATE_HINT =
  'Prints the date the catalogue was generated. **Keep it on** for a dated stock-take or audit record; **turn it off** for a timeless reference sheet you do not want to look out of date.';
const GROUP_BY_HINT =
  'How to divide the catalogue into sections:\n\n' +
  '- **Location** — by where stock sits (and its sub-locations), so a picker can walk the shelves.\n' +
  '- **Category** — by product type, the usual layout for a parts or price list.\n' +
  '- **No grouping** — one flat list, best for a short catalogue or a single selection.';
const SORT_BY_HINT =
  'How items are ordered *within* each section — by **name** (A–Z), by **value** (most valuable first, for a valuation) or by **quantity** (most stock first).';
const PAGE_NUMBERS_HINT =
  'Prints "Page X of Y" at the foot of each page — worth having on a long, multi-page catalogue so pages can be kept in order. Needs a recent browser; older ones simply omit it.';
const RUNNING_HEADER_HINT =
  'Repeats your company name (or the title) at the top of **every** printed page, so each page is identifiable on its own once the catalogue is unstapled. Leave it off for a single-page print.';
const PAPER_PREVIEW_HINT =
  'Shows the catalogue on screen as a **white printed page with black ink**, regardless of your app theme. Handy in dark mode to preview what the printout or PDF will actually look like. Does not change the print itself.';

/**
 * The parts-catalogue screen (issue #22): a printable, column-configurable list of items scoped
 * by all / a location subtree / a project / an ad-hoc selection. It renders on screen with the
 * usual design tokens and prints natively via `window.print()` ("Save as PDF") — no PDF
 * dependency, exactly like the insurance schedule it is modelled on. The print CSS (`@media
 * print` in `styles/index.css`, keyed off the `catalogue-*` classes) drops the app chrome and
 * the configuration panel, forces an ink-friendly light scheme and paginates the tables cleanly.
 * All aggregation lives in the pure `parts-catalogue` seam; this screen is presentation only, and
 * the column selection is applied here at render time.
 *
 * **On screen the document is paged** (issue #410). A catalogue can cover the whole inventory, so
 * reading it in one go does not scale — the previous whole-document read pulled every item in
 * scope into a single array and rendered a non-virtualised table row for each. Section headings
 * and every total now come from a bounded summary read, lines come a page at a time, and the
 * per-line costs the reader opts into (a thumbnail, a QR encode) are paid for a page rather than
 * for a scope.
 *
 * **What prints is never the paged view.** The print CSS hides `.catalogue-window` outright and
 * shows `.catalogue-print-doc` instead, so no route to the printer — the button, Ctrl+P, or the
 * browser's own menu — can emit one page of a catalogue that reads as the whole thing. There are
 * two artefacts, each headed with what it is: a section-subtotal **summary** (always available,
 * always short) and the **full** catalogue, which the Print button loads completely before
 * printing. The same rule, for the same reason, as the insurance schedule (issue #163).
 */
export function CatalogueScreen() {
  const f = useFormatters();
  const projectsEnabled = useEnabledFeatures().has('projects');

  // Persisted print letterhead — set once, reused on every print. Read each field + setter
  // individually so a change to one never re-renders on an unrelated preference.
  const branding: CatalogueBranding = {
    title: usePreferencesStore((s) => s.catalogueTitle),
    orgName: usePreferencesStore((s) => s.catalogueOrgName),
    orgDetails: usePreferencesStore((s) => s.catalogueOrgDetails),
    footer: usePreferencesStore((s) => s.catalogueFooter),
    logo: usePreferencesStore((s) => s.catalogueLogo),
    showGeneratedDate: usePreferencesStore((s) => s.catalogueShowGeneratedDate),
  };
  const setCatalogueTitle = usePreferencesStore((s) => s.setCatalogueTitle);
  const setCatalogueOrgName = usePreferencesStore((s) => s.setCatalogueOrgName);
  const setCatalogueOrgDetails = usePreferencesStore((s) => s.setCatalogueOrgDetails);
  const setCatalogueFooter = usePreferencesStore((s) => s.setCatalogueFooter);
  const setCatalogueLogo = usePreferencesStore((s) => s.setCatalogueLogo);
  const setCatalogueShowGeneratedDate = usePreferencesStore((s) => s.setCatalogueShowGeneratedDate);
  // Print-page furniture (persisted): repeat the letterhead + page numbers on every printed page.
  const pageNumbers = usePreferencesStore((s) => s.cataloguePageNumbers);
  const runningHeader = usePreferencesStore((s) => s.catalogueRunningHeader);
  const setCataloguePageNumbers = usePreferencesStore((s) => s.setCataloguePageNumbers);
  const setCatalogueRunningHeader = usePreferencesStore((s) => s.setCatalogueRunningHeader);
  // Paper-preview (persisted): show the on-screen document as a white printed page.
  const paperPreview = usePreferencesStore((s) => s.cataloguePaperPreview);
  const setCataloguePaperPreview = usePreferencesStore((s) => s.setCataloguePaperPreview);
  // The reader's page size, shared with every other paged list on the device.
  const defaultPageSize = usePreferencesStore((s) => s.defaultPageSize);
  const setDefaultPageSize = usePreferencesStore((s) => s.setDefaultPageSize);
  // The QR column deep-links back to each item; resolve the base URL the same way printed labels do.
  const labelBaseUrl = usePreferencesStore((s) => s.labelBaseUrl);
  // Surfaced if a picked logo can't be decoded (leaves the existing logo untouched).
  const [logoError, setLogoError] = useState('');
  // The "this is a long print" confirmation (issue #338).
  const [confirmingPrint, setConfirmingPrint] = useState(false);
  const t = useT();

  // How the catalogue is laid out — session view choices (like the scope + column picks).
  const [groupBy, setGroupBy] = useState<CatalogueGroupBy>(DEFAULT_CATALOGUE_GROUP_BY);
  const [sortBy, setSortBy] = useState<CatalogueSortBy>(DEFAULT_CATALOGUE_SORT_BY);

  const onPickLogo = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = ''; // let the same file be re-picked after a Remove
    if (!file) return;
    try {
      setLogoError('');
      setCatalogueLogo(await logoToDataUrl(file));
    } catch {
      setLogoError('That image could not be used. Try a different file.');
    }
  };

  // A launcher (e.g. the inventory multi-select "Print catalogue" action) may have stashed a
  // pre-chosen scope. Read it once for the initial state, then consume (clear) it on mount so a
  // later visit doesn't resurrect a stale selection.
  const [launched] = useState<CatalogueScope | null>(() => useCatalogueLaunch.getState().pendingScope);
  useEffect(() => {
    useCatalogueLaunch.getState().consume();
  }, []);

  const [scopeKind, setScopeKind] = useState<ScopeKind>(() =>
    launched ? (launched.kind === 'items' ? 'selection' : launched.kind) : 'all',
  );
  const [locationId, setLocationId] = useState<string>(() =>
    launched?.kind === 'location' ? launched.locationId : '',
  );
  const [projectId, setProjectId] = useState<string>(() =>
    launched?.kind === 'project' ? launched.projectId : '',
  );
  // The ad-hoc selection handed in by the launcher, fixed for this screen's lifetime.
  const [selectionIds] = useState<readonly string[]>(() =>
    launched?.kind === 'items' ? launched.itemIds : [],
  );
  const [fields, setFields] = useState<ReadonlySet<CatalogueFieldKey>>(
    () => new Set(DEFAULT_CATALOGUE_FIELDS),
  );

  const locations = useLocations();
  const projects = useProjects();

  const locationOptions: SelectOption[] = locations.data
    ? flattenLocationHierarchy(
        locations.data.rows.map((l) => ({ id: l.id, name: l.name, parentId: l.parentId })),
      ).map((l) => ({ value: l.id, label: l.path }))
    : [];
  const projectOptions: SelectOption[] = projects.data
    ? projects.data.rows.map((p) => ({ value: p.id, label: p.name }))
    : [];

  const scopeOptions: SelectOption[] = [
    { value: 'all', label: 'All items' },
    { value: 'location', label: 'By location' },
    ...(projectsEnabled ? [{ value: 'project', label: 'By project' }] : []),
    ...(selectionIds.length > 0
      ? [{ value: 'selection', label: `Selected items (${selectionIds.length})` }]
      : []),
  ];

  // The concrete scope to query — null while the reader hasn't finished choosing (no location /
  // project picked, or a "selection" scope with nothing handed in), which keeps the query idle.
  const scope: CatalogueScope | null =
    scopeKind === 'all'
      ? { kind: 'all' }
      : scopeKind === 'location'
        ? locationId
          ? { kind: 'location', locationId }
          : null
        : scopeKind === 'project'
          ? projectId
            ? { kind: 'project', projectId }
            : null
          : selectionIds.length > 0
            ? { kind: 'items', itemIds: selectionIds }
            : null;

  // The document's shape and totals: one bounded read, whatever the scope's size (issue #410).
  // Section headings, per-section counts and every total come from here; the lines beneath them
  // are fetched a page at a time below.
  const summary = usePartsCatalogueSummary(scope, groupBy);
  const itemCount = summary.data?.itemCount ?? 0;
  const printLimit = cataloguePrintLimit(fields);
  const tooLarge = itemCount > printLimit;

  const [page, setPage] = useState(1);
  const totalPages = pageCount(itemCount, defaultPageSize);
  // Keep the requested page inside the document as it changes underneath the reader — the same
  // reset-then-clamp pair the inventory list and the insurance schedule use.
  useEffect(() => {
    setPage(1);
  }, [defaultPageSize, groupBy, sortBy, scopeKind, locationId, projectId]);
  useEffect(() => {
    setPage((current) => clampPage(current, totalPages));
  }, [totalPages]);

  const photosOn = fields.has('photo');
  const pageQuery = usePartsCataloguePage(
    scope,
    summary.data?.groups,
    (page - 1) * defaultPageSize,
    defaultPageSize,
    { includePhotos: photosOn, groupBy, sortBy },
  );

  const selectedFields = CATALOGUE_FIELDS.filter((field) => fields.has(field.key));
  // Per-section subtotals and the grand total are only meaningful — and only shown — when the
  // costed "Line value" column is on and at least one item is actually priced.
  const showTotals = fields.has('lineValue') && (summary.data?.hasValue ?? false);

  // Resolve the deep-link base URL once (as printed labels do); the QR codes themselves are
  // encoded per rendered document, so a page pays for a page's worth and never the scope's.
  const baseUrl = useMemo(
    () =>
      resolveLabelBaseUrl(
        labelBaseUrl,
        typeof window === 'undefined' ? null : window.location.origin,
        import.meta.env.BASE_URL,
      ),
    [labelBaseUrl],
  );
  const qrColumnOn = fields.has('qr');
  // Roughly how long the printed document will be — shown beside the Print button, and the
  // threshold the confirmation below turns on (issue #338).
  const estimatedPages = summary.data
    ? estimateCataloguePages({
        lineCount: summary.data.itemCount,
        groupCount: summary.data.groups.length,
        photos: photosOn,
        qr: qrColumnOn,
      })
    : 0;

  const pageSlices = pageQuery.data ?? NO_SLICES;
  const pageLines = useMemo(() => pageSlices.flatMap((slice) => slice.lines), [pageSlices]);
  const qrByLine = useQrByLine(pageLines, qrColumnOn, baseUrl);
  // The QR column is on and there are lines, but not one encoded — the deep-link is too long for
  // any QR symbol, which only an over-long "Link host" can cause. Surface it rather than
  // rendering a silently blank column.
  const qrTooLong = qrColumnOn && qrByLine !== null && pageLines.length > 0 && qrByLine.size === 0;

  const print = usePreparedCataloguePrint(scope, summary.data, { includePhotos: photosOn, sortBy }, t);

  // The @page running header + page-number CSS, injected as a <style> only when enabled.
  const pageStyle = buildCataloguePageStyle({
    pageNumbers,
    runningHeader,
    headerText: branding.orgName.trim() || branding.title.trim(),
  });

  const toggleField = (key: CatalogueFieldKey) => {
    setFields((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const empty = scope !== null && summary.data != null && summary.data.itemCount === 0;
  const needsChoice = scope === null;
  // The size of the print job, stated before the browser's own dialog can open. Only meaningful
  // once the document's shape is known — there is nothing to print until then.
  const showPrintSize = !needsChoice && !empty && summary.data != null;

  // A long print asks first (issue #338), then the whole document is loaded before the browser's
  // print dialog is raised — see `usePreparedCataloguePrint`.
  const requestPrint = () => {
    if (estimatedPages > CATALOGUE_CONFIRM_PAGES) {
      setConfirmingPrint(true);
      return;
    }
    void print.start();
  };

  return (
    <PageContainer>
      {/* App header + actions — dropped in print (only the document below prints). */}
      <div className="catalogue-chrome">
        <PageHeader
          icon={<CatalogueIcon />}
          title="Catalogue"
          actions={
            <div className="flex flex-wrap items-center gap-3">
              {/* How big the job is, *before* the browser's print dialog opens (issue #338). */}
              {showPrintSize ? (
                <span
                  className="flex items-center gap-1.5 text-sm text-muted-foreground"
                  data-testid="catalogue-print-size"
                >
                  {t('reports.catalogue.scopeSize', { vars: { count: summary.data!.itemCount } })} ·{' '}
                  {t('reports.catalogue.pageEstimate', { vars: { count: estimatedPages } })}
                  <InfoHint content={t('reports.catalogue.pageEstimateHint')} />
                </span>
              ) : null}
              {/* The primary call-to-action on this screen — the standard CTA colour (like
                  "Add item" on the Inventory screen) so the next action is obvious. */}
              <Button
                onClick={requestPrint}
                disabled={needsChoice || empty || tooLarge || print.busy || !summary.data}
                aria-busy={print.busy}
                data-testid="print-catalogue"
              >
                <PrintIcon />
                {print.busy ? t('reports.catalogue.print.preparing') : 'Print / Save as PDF'}
              </Button>
              {print.busy ? (
                <Button variant="ghost" onClick={print.cancel} data-testid="cancel-prepare-catalogue">
                  {t('reports.catalogue.print.cancel')}
                </Button>
              ) : null}
            </div>
          }
        />
        {tooLarge ? (
          <p className="mt-2 text-sm text-muted-foreground" data-testid="catalogue-too-large">
            {t('reports.catalogue.tooLarge', {
              vars: { count: f.quantity(itemCount), limit: f.quantity(printLimit) },
            })}
          </p>
        ) : null}
        <LiveRegion>{print.status}</LiveRegion>
      </div>

      {/* A catalogue can be long without being over the ceiling, and the browser's own print
          dialog was the first place that became apparent. Say so while it can still be stopped. */}
      <Modal
        open={confirmingPrint}
        onClose={() => setConfirmingPrint(false)}
        title={t('reports.catalogue.confirmTitle')}
      >
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {t('reports.catalogue.confirmBody', {
              vars: {
                pages: f.quantity(estimatedPages),
                items: f.quantity(itemCount),
              },
            })}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmingPrint(false)}>
              {t('reports.catalogue.confirmCancel')}
            </Button>
            <Button
              onClick={() => {
                setConfirmingPrint(false);
                void print.start();
              }}
              data-testid="catalogue-print-confirm"
            >
              <PrintIcon />
              {t('reports.catalogue.confirmPrint')}
            </Button>
          </div>
        </div>
      </Modal>

      <main
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        className="catalogue-doc flex flex-1 animate-rise flex-col gap-6 outline-none"
      >
        {/* Configuration panel — the scope, column pickers and print letterhead. Never printed. */}
        <Surface className="print-hide flex flex-col gap-5 p-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <SelectField
              label="Show"
              options={scopeOptions}
              value={scopeKind}
              onChange={(v) => setScopeKind(v as ScopeKind)}
              hint={SHOW_HINT}
              data-testid="catalogue-scope"
            />
            {scopeKind === 'location' ? (
              <SelectField
                label="Location"
                options={locationOptions}
                value={locationId}
                onChange={setLocationId}
                placeholder="Choose a location…"
                hint={LOCATION_HINT}
                data-testid="catalogue-location"
              />
            ) : null}
            {scopeKind === 'project' ? (
              projectOptions.length > 0 ? (
                <SelectField
                  label="Project"
                  options={projectOptions}
                  value={projectId}
                  onChange={setProjectId}
                  placeholder="Choose a project…"
                  hint={PROJECT_HINT}
                  data-testid="catalogue-project"
                />
              ) : (
                // No projects exist — show a plain message where the (otherwise empty) combobox
                // would sit, so the control never renders as a broken, unusable dropdown.
                <div>
                  <span className="mb-field-gap block text-sm font-medium">Project</span>
                  <p className="text-sm text-muted-foreground" data-testid="catalogue-no-projects">
                    No projects are in the system.
                  </p>
                </div>
              )
            ) : null}
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <SelectField
              label="Group by"
              options={CATALOGUE_GROUP_BY}
              value={groupBy}
              onChange={(v) => setGroupBy(v as CatalogueGroupBy)}
              hint={GROUP_BY_HINT}
              data-testid="catalogue-group-by"
            />
            <SelectField
              label="Sort items by"
              options={CATALOGUE_SORT_BY}
              value={sortBy}
              onChange={(v) => setSortBy(v as CatalogueSortBy)}
              hint={SORT_BY_HINT}
              data-testid="catalogue-sort-by"
            />
          </div>

          <fieldset>
            <legend className="mb-field-gap flex items-center gap-1.5 text-sm font-medium">
              Columns
              <InfoHint content={COLUMNS_HINT} />
            </legend>
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3 lg:grid-cols-4">
              {CATALOGUE_FIELDS.map((field) => (
                // The help badge sits *outside* the label so tapping it opens the tooltip
                // rather than toggling the checkbox.
                <div key={field.key} className="flex items-center gap-1.5 text-sm">
                  <label className="flex items-center gap-2">
                    <Checkbox
                      checked={fields.has(field.key)}
                      onChange={() => toggleField(field.key)}
                      data-testid={`catalogue-field-${field.key}`}
                    />
                    {field.label}
                  </label>
                  <InfoHint content={field.help} />
                </div>
              ))}
            </div>
          </fieldset>

          {/* Print letterhead — an optional company logo, name/address, title and footer stamped
              onto the printed document. Persisted, so it's set once and reused on every print. */}
          <details className="group border-t border-border pt-4">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium">
              <ChevronDownIcon
                aria-hidden="true"
                className="size-4 text-muted-foreground transition-transform group-open:rotate-180"
              />
              Header &amp; branding
            </summary>

            <div className="mt-4 flex flex-col gap-4">
              <div>
                <div className="mb-field-gap flex items-center gap-1.5 text-sm font-medium">
                  Logo
                  <InfoHint content={LOGO_HINT} />
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  {branding.logo ? (
                    <img
                      src={branding.logo}
                      alt="Current catalogue logo"
                      className="max-h-12 w-auto rounded border border-border object-contain"
                    />
                  ) : null}
                  <label className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                    <UploadIcon />
                    {branding.logo ? 'Replace logo' : 'Upload logo'}
                    <input
                      type="file"
                      accept="image/*"
                      className="sr-only"
                      aria-label="Upload logo"
                      onChange={onPickLogo}
                    />
                  </label>
                  {branding.logo ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setCatalogueLogo('');
                        setLogoError('');
                      }}
                    >
                      <DeleteIcon />
                      Remove
                    </Button>
                  ) : null}
                </div>
                {logoError ? (
                  <p role="alert" className="mt-1 text-xs text-destructive">
                    {logoError}
                  </p>
                ) : null}
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <FormField label="Title" hint={TITLE_HINT}>
                  <Input
                    value={branding.title}
                    onChange={(e) => setCatalogueTitle(e.target.value)}
                    placeholder="Catalogue"
                    data-testid="catalogue-branding-title"
                  />
                </FormField>
                <FormField label="Company name" hint={ORG_NAME_HINT}>
                  <Input
                    value={branding.orgName}
                    onChange={(e) => setCatalogueOrgName(e.target.value)}
                    data-testid="catalogue-branding-org"
                  />
                </FormField>
              </div>

              <FormField label="Address / contact" hint={ORG_DETAILS_HINT}>
                <Textarea
                  sizeKey="catalogue.org-details"
                  autoGrow
                  value={branding.orgDetails}
                  onChange={(e) => setCatalogueOrgDetails(e.target.value)}
                  rows={3}
                  data-testid="catalogue-branding-details"
                />
              </FormField>

              <FormField label="Footer" hint={FOOTER_HINT}>
                <Input
                  value={branding.footer}
                  onChange={(e) => setCatalogueFooter(e.target.value)}
                  data-testid="catalogue-branding-footer"
                />
              </FormField>

              {/* The three print switches share one wrapping row to save vertical space. */}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
                <div className="flex items-center gap-1.5">
                  <label className="flex items-center gap-2">
                    <Checkbox
                      checked={branding.showGeneratedDate}
                      onChange={(e) => setCatalogueShowGeneratedDate(e.target.checked)}
                      data-testid="catalogue-branding-show-date"
                    />
                    Show date
                  </label>
                  <InfoHint content={SHOW_DATE_HINT} />
                </div>

                <div className="flex items-center gap-1.5">
                  <label className="flex items-center gap-2">
                    <Checkbox
                      checked={pageNumbers}
                      onChange={(e) => setCataloguePageNumbers(e.target.checked)}
                      data-testid="catalogue-page-numbers"
                    />
                    Page numbers
                  </label>
                  <InfoHint content={PAGE_NUMBERS_HINT} />
                </div>

                <div className="flex items-center gap-1.5">
                  <label className="flex items-center gap-2">
                    <Checkbox
                      checked={runningHeader}
                      onChange={(e) => setCatalogueRunningHeader(e.target.checked)}
                      data-testid="catalogue-running-header"
                    />
                    Running header
                  </label>
                  <InfoHint content={RUNNING_HEADER_HINT} />
                </div>
              </div>
            </div>
          </details>

          {/* Sits at the foot of the config panel, next to the preview it controls. */}
          <div className="flex items-center gap-1.5 border-t border-border pt-4 text-sm">
            <label className="flex items-center gap-2">
              <Checkbox
                checked={paperPreview}
                onChange={(e) => setCataloguePaperPreview(e.target.checked)}
                data-testid="catalogue-paper-preview"
              />
              Preview on white paper
            </label>
            <InfoHint content={PAPER_PREVIEW_HINT} />
          </div>

          {qrTooLong ? (
            <p role="alert" className="pt-3 text-xs text-destructive" data-testid="catalogue-qr-too-long">
              {t('inventory.qr.tooLongCatalogue')}
            </p>
          ) : null}
        </Surface>

        {/* The document itself — optionally dressed as a white printed page for on-screen
            preview (the `catalogue-paper` hook is styled screen-only in `styles/index.css`). */}
        <div
          className={cn('flex flex-col gap-6', paperPreview && 'catalogue-paper')}
          data-testid="catalogue-preview"
        >
          {/* Print-only @page furniture (running header + page numbers), for whichever artefact
              reaches the printer. Injected as raw CSS; the text is escaped in
              `buildCataloguePageStyle`, and a text child of <style> is not re-parsed as HTML,
              so this cannot break out. */}
          {pageStyle ? <style>{pageStyle}</style> : null}
          {needsChoice ? (
            <p className="py-16 text-center text-sm text-muted-foreground">
              {scopeKind === 'location'
                ? 'Choose a location to build its catalogue.'
                : scopeKind === 'project'
                  ? projectOptions.length > 0
                    ? 'Choose a project to build its parts catalogue.'
                    : 'Add a project to build a parts catalogue for it.'
                  : 'No items are selected.'}
            </p>
          ) : summary.isError ? (
            <p role="alert" className="py-16 text-center text-sm text-destructive">
              The catalogue could not be loaded.
            </p>
          ) : !summary.data ? (
            <div className="grid place-items-center py-16">
              <Spinner />
            </div>
          ) : empty ? (
            <p className="py-16 text-center text-sm text-muted-foreground">No items match this selection.</p>
          ) : (
            <>
              {/* Screen-only: the paged reading view. Hidden in print (see the
                  `.catalogue-window` rule in styles/index.css) because part of a catalogue must
                  never reach paper under a heading that claims the whole of it. */}
              <section className="catalogue-window flex flex-col gap-6" data-testid="catalogue-window">
                <CatalogueHeader
                  summary={summary.data}
                  branding={branding}
                  showTotals={showTotals}
                  formatters={f}
                />
                {pageQuery.isPending && !pageQuery.data ? (
                  <div className="grid place-items-center py-16">
                    <Spinner />
                  </div>
                ) : (
                  <PagedSections
                    groups={summary.data.groups}
                    slices={pageSlices}
                    fields={selectedFields}
                    showTotals={showTotals}
                    ctx={{ f, qrByLine }}
                    t={t}
                  />
                )}
                <Pagination
                  page={page}
                  pageCount={totalPages}
                  onPageChange={setPage}
                  pageSize={defaultPageSize}
                  onPageSizeChange={setDefaultPageSize}
                  pageSizeOptions={PAGE_SIZE_PRESETS}
                  minPageSize={PAGE_SIZE_BOUNDS.min}
                  maxPageSize={PAGE_SIZE_BOUNDS.max}
                  totalItems={itemCount}
                  data-testid="catalogue-pagination"
                />
                <CatalogueTotals summary={summary.data} showTotals={showTotals} formatters={f} />
                <CatalogueBrandingFooter branding={branding} />
              </section>

              {/* Print-only: whichever complete artefact is ready. Never derived from the paged
                  view above, so what prints always matches its own heading. */}
              <section className="catalogue-print-doc" data-testid="catalogue-print-doc">
                <CataloguePrintDocument
                  summary={summary.data}
                  lines={print.lines}
                  fields={selectedFields}
                  showTotals={showTotals}
                  branding={branding}
                  qrColumnOn={qrColumnOn}
                  baseUrl={baseUrl}
                  formatters={f}
                  t={t}
                />
              </section>
            </>
          )}
        </div>
      </main>
    </PageContainer>
  );
}

/**
 * Encode one QR SVG per line, but only while the QR column is on.
 *
 * Keyed on the lines actually rendered, so the cost is a page's worth of codes and never the
 * scope's — the whole-document encode this replaced was the other half of what made a large
 * catalogue unusable (issue #410). A deep-link too long to encode (an over-long "Link host")
 * leaves that line without a code rather than throwing out of a render-time memo.
 */
function useQrByLine(
  lines: readonly CatalogueLine[],
  qrColumnOn: boolean,
  baseUrl: string,
): ReadonlyMap<string, string> | null {
  return useMemo(() => {
    if (!qrColumnOn) return null;
    const map = new Map<string, string>();
    for (const line of lines) {
      const svg = qrSvgOrNull(buildItemQrUrl(line.id, baseUrl), { scale: 3 });
      if (svg) map.set(line.id, svg);
    }
    return map;
  }, [lines, qrColumnOn, baseUrl]);
}

/**
 * Drive the "prepare the whole document, then print" flow.
 *
 * The document is loaded into state and `window.print()` is called from an effect once React has
 * committed it — never synchronously from the click handler, which would raise the print dialog
 * against a half-built page. When the Photo column is on, every image is decoded first or the
 * thumbnails print blank. `afterprint` drops the document again so a whole catalogue's rows are
 * not held alive once the print is over, and a prepared document is dropped whenever the columns,
 * the sort or the underlying summary change — a document that no longer matches the settings it
 * was built under is a wrong document, not a stale one.
 */
function usePreparedCataloguePrint(
  scope: CatalogueScope | null,
  summary: PartsCatalogueSummary | undefined,
  options: { readonly includePhotos: boolean; readonly sortBy: CatalogueSortBy },
  t: ReturnType<typeof useT>,
) {
  const [lines, setLines] = useState<Map<string | null, CatalogueLine[]> | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const { includePhotos, sortBy } = options;

  // A prepared document is only valid for the settings it was prepared under.
  useEffect(() => {
    setLines(null);
  }, [includePhotos, sortBy, summary]);

  useEffect(() => {
    const drop = () => setLines(null);
    window.addEventListener('afterprint', drop);
    return () => window.removeEventListener('afterprint', drop);
  }, []);

  // Print only once the full document has actually been committed to the DOM.
  useEffect(() => {
    if (lines === null) return;
    let cancelled = false;
    void (async () => {
      // Thumbnails are decoded before the dialog opens, or they print as blanks.
      const images = Array.from(document.querySelectorAll<HTMLImageElement>('.catalogue-print-doc img'));
      await Promise.all(images.map((img) => img.decode().catch(() => undefined)));
      if (!cancelled) window.print();
    })();
    return () => {
      cancelled = true;
    };
  }, [lines]);

  const start = useCallback(async () => {
    if (scope === null || summary === undefined) return;
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setStatus(t('reports.catalogue.print.preparing'));
    try {
      const loaded = await loadFullCatalogueLines(
        scope,
        summary.groups,
        { includePhotos, sortBy },
        (done, total) =>
          setStatus(
            t('reports.catalogue.print.progress', {
              vars: { done: String(done), total: String(total) },
            }),
          ),
        controller.signal,
      );
      setLines(loaded);
      setStatus(t('reports.catalogue.print.ready'));
    } catch (err) {
      setStatus(
        (err as Error)?.name === 'AbortError'
          ? t('reports.catalogue.print.cancelled')
          : t('reports.catalogue.print.failed'),
      );
    } finally {
      setBusy(false);
      abort.current = null;
    }
  }, [scope, summary, includePhotos, sortBy, t]);

  const cancel = useCallback(() => abort.current?.abort(), []);

  return { lines, status, busy, start, cancel };
}

/**
 * The document's letterhead and title band: the optional branding, the title, when it was
 * generated, how many items it covers and — with the costed column on — its grand total.
 */
function CatalogueHeader({
  summary,
  branding,
  showTotals,
  formatters,
  printedCount,
}: {
  summary: PartsCatalogueSummary;
  branding: CatalogueBranding;
  showTotals: boolean;
  formatters: Formatters;
  /** Items the artefact this heads actually holds; defaults to the whole document's count. */
  printedCount?: number;
}) {
  const f = formatters;
  const count = printedCount ?? summary.itemCount;
  // Gate each letterhead element on *trimmed* content so a whitespace-only field prints nothing,
  // while still rendering exactly what the reader typed (their newlines/spacing are preserved).
  const showOrgName = branding.orgName.trim().length > 0;
  const showOrgDetails = branding.orgDetails.trim().length > 0;
  const hasLetterhead = Boolean(branding.logo) || showOrgName || showOrgDetails;
  return (
    <header className="flex flex-col gap-3 border-b border-border pb-4">
      {hasLetterhead ? (
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-0.5">
            {showOrgName ? (
              <p className="text-base font-semibold text-foreground" data-testid="catalogue-org-name">
                {branding.orgName}
              </p>
            ) : null}
            {showOrgDetails ? (
              <p className="whitespace-pre-line text-sm text-muted-foreground">{branding.orgDetails}</p>
            ) : null}
          </div>
          {branding.logo ? (
            <img
              src={branding.logo}
              alt={showOrgName ? `${branding.orgName.trim()} logo` : 'Catalogue logo'}
              className="catalogue-logo max-h-20 w-auto shrink-0 object-contain"
            />
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold" data-testid="catalogue-title">
          {branding.title.trim() || 'Catalogue'}
        </h2>
        <p className="text-sm text-muted-foreground">
          {branding.showGeneratedDate ? <>Generated {f.date(summary.generatedAt)} · </> : null}
          {f.quantity(count)} {plural(count, 'item')}
          {showTotals ? (
            <>
              {' · total value '}
              <Money
                value={summary.grandTotal}
                formatters={f}
                className="font-medium text-foreground"
                data-testid="catalogue-grand-total"
              />
            </>
          ) : null}
        </p>
      </div>
    </header>
  );
}

/** The closing totals rule: the item count and total quantity always, the value when priced. */
function CatalogueTotals({
  summary,
  showTotals,
  formatters,
}: {
  summary: PartsCatalogueSummary;
  showTotals: boolean;
  formatters: Formatters;
}) {
  const f = formatters;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t-2 border-border pt-3 text-base font-semibold">
      <span>Total</span>
      <span className="flex flex-wrap items-center gap-x-3 tabular-nums">
        <span>
          {f.quantity(summary.itemCount)} {plural(summary.itemCount, 'item')}
        </span>
        <span data-testid="catalogue-total-quantity">{f.quantity(summary.totalQuantity)} in stock</span>
        {showTotals ? <Money value={summary.grandTotal} formatters={f} /> : null}
      </span>
    </div>
  );
}

/** The optional closing branding line (a confidentiality or copyright notice). */
function CatalogueBrandingFooter({ branding }: { branding: CatalogueBranding }) {
  if (branding.footer.trim().length === 0) return null;
  return (
    <footer
      className="border-t border-border pt-3 text-xs text-muted-foreground"
      data-testid="catalogue-footer"
    >
      {branding.footer}
    </footer>
  );
}

/** The sections touched by the current page, each showing how much of it is on screen. */
function PagedSections({
  groups,
  slices,
  fields,
  showTotals,
  ctx,
  t,
}: {
  groups: readonly CatalogueGroupSummary[];
  slices: readonly CataloguePageSlice[];
  fields: readonly (typeof CATALOGUE_FIELDS)[number][];
  showTotals: boolean;
  ctx: RenderCtx;
  t: ReturnType<typeof useT>;
}) {
  const byId = useMemo(() => new Map(groups.map((g) => [g.groupId, g])), [groups]);
  return (
    <>
      {slices.map((slice) => {
        const group = byId.get(slice.groupId);
        if (group === undefined) return null;
        return (
          <CatalogueGroupSection
            key={group.groupId ?? 'ungrouped'}
            group={group}
            lines={slice.lines}
            fields={fields}
            showTotals={showTotals}
            ctx={ctx}
            // A partial section must say so. A bare count beside part of a section reads as the
            // whole section — exactly the misreading the print rules exist to prevent.
            showingLabel={
              slice.lines.length < group.itemCount
                ? t('reports.catalogue.group.showingOf', {
                    vars: {
                      shown: ctx.f.quantity(slice.lines.length),
                      total: ctx.f.quantity(group.itemCount),
                    },
                  })
                : null
            }
          />
        );
      })}
    </>
  );
}

/**
 * The artefact that actually prints: the full catalogue once it has been prepared, otherwise a
 * section-subtotal summary. Both carry a heading naming which they are, so a printed page can
 * never misrepresent its own completeness.
 */
function CataloguePrintDocument({
  summary,
  lines,
  fields,
  showTotals,
  branding,
  qrColumnOn,
  baseUrl,
  formatters,
  t,
}: {
  summary: PartsCatalogueSummary;
  lines: Map<string | null, CatalogueLine[]> | null;
  fields: readonly (typeof CATALOGUE_FIELDS)[number][];
  showTotals: boolean;
  branding: CatalogueBranding;
  qrColumnOn: boolean;
  baseUrl: string;
  formatters: Formatters;
  t: ReturnType<typeof useT>;
}) {
  const f = formatters;
  const full = lines !== null;
  // Count what is actually on the page, not what the summary said there would be. The two agree
  // unless the inventory changed mid-load, and in that case the heading must describe the
  // document in front of the reader — a heading is only a guarantee if it is derived from the
  // thing it describes.
  const printedCount = full
    ? summary.groups.reduce((sum, g) => sum + (lines.get(g.groupId)?.length ?? 0), 0)
    : summary.itemCount;
  const printedLines = useMemo(
    () => (lines === null ? [] : summary.groups.flatMap((g) => lines.get(g.groupId) ?? [])),
    [lines, summary.groups],
  );
  const qrByLine = useQrByLine(printedLines, qrColumnOn, baseUrl);

  return (
    <>
      <CatalogueHeader
        summary={summary}
        branding={branding}
        showTotals={showTotals}
        formatters={f}
        printedCount={printedCount}
      />
      <p className="text-sm font-medium" data-testid="catalogue-print-heading">
        {full
          ? t('reports.catalogue.print.fullHeading', { vars: { count: f.quantity(printedCount) } })
          : t('reports.catalogue.print.summaryHeading')}
      </p>
      {full ? null : (
        <p className="text-sm text-muted-foreground">{t('reports.catalogue.print.summaryCaveat')}</p>
      )}

      {full ? (
        summary.groups.map((group) => (
          <CatalogueGroupSection
            key={group.groupId ?? 'ungrouped'}
            group={group}
            lines={lines.get(group.groupId) ?? []}
            fields={fields}
            showTotals={showTotals}
            ctx={{ f, qrByLine }}
          />
        ))
      ) : (
        <table className="catalogue-table w-full text-sm">
          <caption className="sr-only">{t('reports.catalogue.print.summaryHeading')}</caption>
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="py-2 pr-3 font-medium">
                {t('reports.catalogue.summaryTable.section')}
              </th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">
                {t('reports.catalogue.summaryTable.items')}
              </th>
              {showTotals ? (
                <th scope="col" className="py-2 text-right font-medium">
                  {t('reports.catalogue.summaryTable.subtotal')}
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {summary.groups.map((group) => (
              <tr key={group.groupId ?? 'ungrouped'} className="border-t border-border">
                <td className="py-2 pr-3">
                  {group.groupLabel || t('reports.catalogue.summaryTable.allItems')}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">{f.quantity(group.itemCount)}</td>
                {showTotals ? (
                  <td className="py-2 text-right font-medium">
                    <Money value={group.subtotal} formatters={f} />
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <CatalogueTotals summary={summary} showTotals={showTotals} formatters={f} />
      <CatalogueBrandingFooter branding={branding} />
    </>
  );
}

/** One catalogue section: an optional heading (with its totals), then the item table. */
function CatalogueGroupSection({
  group,
  lines,
  fields,
  showTotals,
  ctx,
  showingLabel,
}: {
  group: CatalogueGroupSummary;
  lines: readonly CatalogueLine[];
  fields: readonly (typeof CATALOGUE_FIELDS)[number][];
  showTotals: boolean;
  ctx: RenderCtx;
  showingLabel?: string | null;
}) {
  const f = ctx.f;
  // The "No grouping" layout produces a single unheaded section.
  const hasHeading = group.groupLabel.length > 0;
  return (
    <section className="flex flex-col gap-2">
      {hasHeading ? (
        <div className="catalogue-group-heading flex flex-wrap items-baseline justify-between gap-2 border-b border-border pb-1">
          <h3 className="font-semibold">{group.groupLabel}</h3>
          <span className="text-sm text-muted-foreground">
            {showingLabel ? (
              <>{showingLabel} · </>
            ) : (
              <>
                {f.quantity(group.itemCount)} {plural(group.itemCount, 'item')} ·{' '}
              </>
            )}
            {f.quantity(group.totalQuantity)} in stock
            {showTotals ? (
              <>
                {' · subtotal '}
                <Money value={group.subtotal} formatters={f} className="font-medium text-foreground" />
              </>
            ) : null}
          </span>
        </div>
      ) : null}

      <div className="catalogue-table-scroll overflow-x-auto">
        <table className="catalogue-table w-full text-sm">
          <caption className="sr-only">{hasHeading ? `Items in ${group.groupLabel}` : 'Items'}</caption>
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="py-2 pr-3 font-medium">
                Item
              </th>
              {fields.map((field) => (
                <th
                  key={field.key}
                  scope="col"
                  className={`py-2 pr-3 font-medium ${field.align === 'right' ? 'text-right' : ''}`}
                >
                  {field.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.id} className="border-t border-border align-top">
                <td className="py-2 pr-3 font-medium">{line.name}</td>
                {fields.map((field) => (
                  <td
                    key={field.key}
                    className={`py-2 pr-3 ${field.align === 'right' ? 'text-right tabular-nums' : ''}`}
                  >
                    {renderField(line, field.key, ctx)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** A dimmed em-dash for an absent value, so every empty cell reads the same. */
function Blank() {
  return <span className="text-muted-foreground">—</span>;
}

/** Render one line's value for a given column. Absent values become a consistent em-dash. */
function renderField(line: CatalogueLine, key: CatalogueFieldKey, ctx: RenderCtx): ReactNode {
  const f = ctx.f;
  switch (key) {
    case 'photo':
      return line.thumbnail && line.thumbnail.byteLength > 0 ? (
        <Thumbnail
          bytes={line.thumbnail}
          alt={line.name}
          className="catalogue-photo size-12 rounded border border-border object-cover"
        />
      ) : (
        <Blank />
      );
    case 'qr': {
      const svg = ctx.qrByLine?.get(line.id);
      // The QR SVG is generated locally from the item's deep-link (safe, not user HTML).
      return svg ? (
        <span
          className="catalogue-qr inline-block size-16 [&_svg]:h-full [&_svg]:w-full"
          aria-label={`QR code for ${line.name}`}
          role="img"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <Blank />
      );
    }
    case 'category':
      return line.category ?? <Blank />;
    case 'description':
      return line.description ?? <Blank />;
    case 'quantity':
      return `${f.quantity(line.quantity)}${line.unitOfMeasure ? ` ${line.unitOfMeasure}` : ''}`;
    case 'condition':
      return line.condition ? (
        <span className={CONDITION_COLOR_CLASS[line.condition]}>{CONDITION_LABELS[line.condition]}</span>
      ) : (
        <Blank />
      );
    case 'serial':
      return line.serialNo != null ? line.serialNo : <Blank />;
    case 'mpn':
      return line.mpn ?? <Blank />;
    case 'manufacturer':
      return line.manufacturer ?? <Blank />;
    case 'supplier':
      return line.supplier ?? <Blank />;
    case 'unitCost':
      return line.unitCost != null ? <Money value={line.unitCost} formatters={f} /> : <Blank />;
    case 'lineValue':
      return line.lineValue != null ? <Money value={line.lineValue} formatters={f} /> : <Blank />;
    case 'purchasePrice':
      return line.purchasePrice != null ? <Money value={line.purchasePrice} formatters={f} /> : <Blank />;
    case 'acquired':
      return formatAcquired(line.acquiredAt, f);
    case 'warranty':
      return (
        <span className={WARRANTY_STATUS_COLOR_CLASS[line.warranty]}>
          {WARRANTY_STATUS_LABEL[line.warranty]}
        </span>
      );
    case 'notes':
      return line.notes ?? <Blank />;
    default:
      // `ReactNode` *includes* `undefined`, so the explicit return type does not make the
      // end point unreachable and TS2366 never fires — the guard has to be explicit
      // (issue #355). Without it a new `CatalogueFieldKey` would print an empty cell in
      // every row, with nothing to say the column exists but goes unrendered.
      assertExhaustive(key);
      return <Blank />;
  }
}

/** Format an ISO `YYYY-MM-DD` acquisition date for display, or an em-dash when unset/invalid. */
function formatAcquired(acquiredAt: string | null, f: Formatters): ReactNode {
  if (!acquiredAt) return <Blank />;
  const ms = Date.parse(acquiredAt);
  return Number.isFinite(ms) ? f.calendarDate(ms) : <Blank />;
}
