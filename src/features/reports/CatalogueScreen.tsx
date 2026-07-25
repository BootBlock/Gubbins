import { useEffect, useMemo, useState, type ChangeEvent, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import {
  Button,
  buttonVariants,
  Checkbox,
  FormField,
  InfoHint,
  Input,
  Modal,
  Money,
  PageContainer,
  PageHeader,
  SelectField,
  Spinner,
  Surface,
  Textarea,
  MAIN_CONTENT_ID,
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
  type CatalogueGroup,
  type CatalogueGroupBy,
  type CatalogueLine,
  type CatalogueScope,
  type CatalogueSortBy,
  type PartsCatalogue,
} from './parts-catalogue';
import { useCatalogueItemCount, usePartsCatalogue } from './queries';
import { useCatalogueLaunch } from './useCatalogueLaunch';

/** Render context threaded to {@link renderField} — the formatters plus the per-item QR SVGs. */
interface RenderCtx {
  readonly f: Formatters;
  /** Pre-rendered QR SVG per line id when the QR column is on, else null. */
  readonly qrByLine: ReadonlyMap<string, string> | null;
}

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
 * All aggregation lives in the pure {@link usePartsCatalogue} → `buildPartsCatalogue` seam; this
 * screen is presentation only, and the column selection is applied here at render time.
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
  // The QR column deep-links back to each item; resolve the base URL the same way printed labels do.
  const labelBaseUrl = usePreferencesStore((s) => s.labelBaseUrl);
  // Surfaced if a picked logo can't be decoded (leaves the existing logo untouched).
  const [logoError, setLogoError] = useState('');
  // The "this is a long print" confirmation, and the flag that fires the print once it has
  // actually left the DOM (issue #338).
  const [confirmingPrint, setConfirmingPrint] = useState(false);
  const [printArmed, setPrintArmed] = useState(false);
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

  // Count the scope before building it (issue #338). The catalogue reads every item in scope into
  // one document and encodes one QR per line, so "All items" over a large inventory has to be
  // headed off *before* the read — not warned about once the tab is already wedged.
  const scopeCount = useCatalogueItemCount(scope);
  const printLimit = cataloguePrintLimit(fields);
  /** The scope's size, once known. `null` while it is still being counted. */
  const scopeItemCount = scopeCount.data ?? null;
  const tooLarge = scopeItemCount != null && scopeItemCount > printLimit;

  const catalogue = usePartsCatalogue(scope, {
    includePhotos: fields.has('photo'),
    groupBy,
    sortBy,
    // Both hooks run in the same render, so "not counted yet" must gate the read as firmly as
    // "too large" does. Treating an unknown size as small enough would fire the unbounded read
    // in parallel with the count on the very first render — and React Query does not abort a
    // request once it is in flight, so the tab would pay for the whole document before the
    // count that was supposed to prevent it ever arrived.
    enabled: scopeItemCount != null && !tooLarge,
  });
  const selectedFields = CATALOGUE_FIELDS.filter((field) => fields.has(field.key));
  // Per-group subtotals and the grand total are only meaningful — and only shown — when the
  // costed "Line value" column is on and at least one item is actually priced.
  const showTotals = fields.has('lineValue') && (catalogue.data?.hasValue ?? false);

  // Resolve the deep-link base URL once (as printed labels do), then pre-render one QR SVG per
  // item — but only when the QR column is on, so a plain catalogue never pays for QR encoding.
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
  const estimatedPages = catalogue.data
    ? estimateCataloguePages({
        lineCount: catalogue.data.itemCount,
        groupCount: catalogue.data.groups.length,
        photos: fields.has('photo'),
        qr: qrColumnOn,
      })
    : 0;
  const qrByLine = useMemo<ReadonlyMap<string, string> | null>(() => {
    // `tooLarge` is checked here as well as at the read: the QR column is not part of the
    // catalogue's query key, so ticking it neither re-keys nor drops the document already in
    // cache — it only lowers the ceiling. Without this guard, turning QR on over a large scope
    // would encode a code for every line of a document the screen is about to decline to show.
    if (tooLarge || !qrColumnOn || !catalogue.data) return null;
    const map = new Map<string, string>();
    for (const group of catalogue.data.groups) {
      for (const line of group.lines) {
        // Guarded: a deep-link too long to encode (an over-long "Link host") leaves that
        // line without a QR rather than throwing out of this render-time memo.
        const svg = qrSvgOrNull(buildItemQrUrl(line.id, baseUrl), { scale: 3 });
        if (svg) map.set(line.id, svg);
      }
    }
    return map;
    // Keyed on the boolean (not the whole `fields` Set) so toggling an unrelated column never
    // regenerates every QR.
  }, [tooLarge, qrColumnOn, catalogue.data, baseUrl]);
  // The QR column is on and there are lines, but not one encoded — the deep-link is too long for
  // any QR symbol, which only an over-long "Link host" can cause. Surface it rather than
  // rendering a silently blank column.
  const lineCount = catalogue.data?.groups.reduce((n, g) => n + g.lines.length, 0) ?? 0;
  const qrTooLong = qrColumnOn && qrByLine !== null && lineCount > 0 && qrByLine.size === 0;

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

  const empty = scope !== null && catalogue.data != null && catalogue.data.itemCount === 0;
  const needsChoice = scope === null;
  /**
   * The scope's size is not known yet.
   *
   * While it isn't, any document on screen belongs to the *previous* scope (both reads keep the
   * last result to avoid flicker), and nothing can say whether the new one is even printable —
   * so neither the size readout nor the Print button may speak for it.
   */
  const sizing = !needsChoice && scopeItemCount == null;
  // The size of the print job, stated before the browser's own dialog can open. Only meaningful
  // once the document exists — there is nothing to print until then.
  const showPrintSize = !needsChoice && !sizing && !tooLarge && !empty && catalogue.data != null;

  // A long print asks first (issue #338). `window.print()` blocks synchronously, so it must not
  // be called from the confirm handler — React would not have committed the dialog's unmount
  // yet, and the overlay would print across the first page. Arming a flag and printing from the
  // effect that follows the commit keeps the paper clean.
  const requestPrint = () => {
    if (estimatedPages > CATALOGUE_CONFIRM_PAGES) {
      setConfirmingPrint(true);
      return;
    }
    window.print();
  };
  useEffect(() => {
    if (!printArmed) return;
    setPrintArmed(false);
    window.print();
  }, [printArmed]);

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
                  {t('reports.catalogue.scopeSize', { vars: { count: catalogue.data!.itemCount } })} ·{' '}
                  {t('reports.catalogue.pageEstimate', { vars: { count: estimatedPages } })}
                  <InfoHint content={t('reports.catalogue.pageEstimateHint')} />
                </span>
              ) : null}
              {/* The primary call-to-action on this screen — the standard CTA colour (like
                  "Add item" on the Inventory screen) so the next action is obvious. */}
              <Button
                onClick={requestPrint}
                disabled={
                  needsChoice || sizing || empty || tooLarge || catalogue.isLoading || !catalogue.data
                }
                data-testid="print-catalogue"
              >
                <PrintIcon />
                Print / Save as PDF
              </Button>
            </div>
          }
        />
        {tooLarge ? (
          <p className="mt-2 text-sm text-muted-foreground" data-testid="catalogue-too-large">
            {t('reports.catalogue.tooLarge', {
              vars: { count: f.quantity(scopeItemCount ?? 0), limit: f.quantity(printLimit) },
            })}
          </p>
        ) : null}
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
                items: f.quantity(catalogue.data?.itemCount ?? 0),
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
                setPrintArmed(true);
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
          ) : tooLarge ? (
            // Checked ahead of the document: the scope's read is disabled at this size, so
            // whatever `catalogue.data` still holds describes a *different* scope — showing it
            // would present one selection's document under another's heading.
            <p className="py-16 text-center text-sm text-muted-foreground">
              {t('reports.catalogue.tooLargeDocument')}
            </p>
          ) : catalogue.isError ? (
            <p role="alert" className="py-16 text-center text-sm text-destructive">
              The catalogue could not be loaded.
            </p>
          ) : !catalogue.data ? (
            // Covers the read itself *and* the window before it starts, while the scope is still
            // being counted — the document read is idle then, so there is no `isLoading` to key
            // off and nothing yet to render.
            <div className="grid place-items-center py-16">
              <Spinner />
            </div>
          ) : empty ? (
            <p className="py-16 text-center text-sm text-muted-foreground">No items match this selection.</p>
          ) : (
            <CatalogueDocument
              catalogue={catalogue.data!}
              fields={selectedFields}
              showTotals={showTotals}
              branding={branding}
              qrByLine={qrByLine}
              pageStyle={pageStyle}
              formatters={f}
            />
          )}
        </div>
      </main>
    </PageContainer>
  );
}

/** The document body: an optional letterhead, the title/metadata band, the location groups,
 * an optional totals footer and an optional branding footer line. */
function CatalogueDocument({
  catalogue,
  fields,
  showTotals,
  branding,
  qrByLine,
  pageStyle,
  formatters,
}: {
  catalogue: PartsCatalogue;
  fields: readonly (typeof CATALOGUE_FIELDS)[number][];
  showTotals: boolean;
  branding: CatalogueBranding;
  qrByLine: ReadonlyMap<string, string> | null;
  /** `@page` running-header + page-number CSS to inject for print, or '' for none. */
  pageStyle: string;
  formatters: Formatters;
}) {
  const f = formatters;
  const ctx: RenderCtx = { f, qrByLine };
  // Gate each letterhead element on *trimmed* content so a whitespace-only field prints nothing,
  // while still rendering exactly what the reader typed (their newlines/spacing are preserved).
  const showOrgName = branding.orgName.trim().length > 0;
  const showOrgDetails = branding.orgDetails.trim().length > 0;
  const hasLetterhead = Boolean(branding.logo) || showOrgName || showOrgDetails;
  return (
    <>
      {/* Print-only @page furniture (running header + page numbers). Injected as raw CSS; the
          text is escaped in `buildCataloguePageStyle`, and a text child of <style> is not
          re-parsed as HTML, so this cannot break out. */}
      {pageStyle ? <style>{pageStyle}</style> : null}
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
            {branding.showGeneratedDate ? <>Generated {f.date(catalogue.generatedAt)} · </> : null}
            {f.quantity(catalogue.itemCount)} {plural(catalogue.itemCount, 'item')}
            {showTotals ? (
              <>
                {' · total value '}
                <Money
                  value={catalogue.grandTotal}
                  formatters={f}
                  className="font-medium text-foreground"
                  data-testid="catalogue-grand-total"
                />
              </>
            ) : null}
          </p>
        </div>
      </header>

      {catalogue.groups.map((group) => (
        <CatalogueGroupSection
          key={group.groupId ?? 'ungrouped'}
          group={group}
          fields={fields}
          showTotals={showTotals}
          ctx={ctx}
        />
      ))}

      {/* Grand totals — the item count and total quantity always, plus the value when priced. */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t-2 border-border pt-3 text-base font-semibold">
        <span>Total</span>
        <span className="flex flex-wrap items-center gap-x-3 tabular-nums">
          <span>
            {f.quantity(catalogue.itemCount)} {plural(catalogue.itemCount, 'item')}
          </span>
          <span data-testid="catalogue-total-quantity">{f.quantity(catalogue.totalQuantity)} in stock</span>
          {showTotals ? <Money value={catalogue.grandTotal} formatters={f} /> : null}
        </span>
      </div>

      {branding.footer.trim().length > 0 ? (
        <footer
          className="border-t border-border pt-3 text-xs text-muted-foreground"
          data-testid="catalogue-footer"
        >
          {branding.footer}
        </footer>
      ) : null}
    </>
  );
}

/** One catalogue section: an optional heading (with its totals), then the item table. */
function CatalogueGroupSection({
  group,
  fields,
  showTotals,
  ctx,
}: {
  group: CatalogueGroup;
  fields: readonly (typeof CATALOGUE_FIELDS)[number][];
  showTotals: boolean;
  ctx: RenderCtx;
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
            {f.quantity(group.lines.length)} {plural(group.lines.length, 'item')} ·{' '}
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
            {group.lines.map((line) => (
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
  }
}

/** Format an ISO `YYYY-MM-DD` acquisition date for display, or an em-dash when unset/invalid. */
function formatAcquired(acquiredAt: string | null, f: Formatters): ReactNode {
  if (!acquiredAt) return <Blank />;
  const ms = Date.parse(acquiredAt);
  return Number.isFinite(ms) ? f.calendarDate(ms) : <Blank />;
}
