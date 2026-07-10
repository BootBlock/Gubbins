import { useEffect, useState, type ChangeEvent, type ReactNode } from 'react';
import {
  Button,
  buttonVariants,
  Checkbox,
  FormField,
  InfoHint,
  Input,
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
import {
  CONDITION_COLOR_CLASS,
  CONDITION_LABELS,
  WARRANTY_STATUS_COLOR_CLASS,
  WARRANTY_STATUS_LABEL,
} from '@/features/inventory/components/inventory-ui';
import { useLocations } from '@/features/inventory/queries';
import { useProjects } from '@/features/projects/projects';
import { flattenLocationHierarchy } from './insurance-schedule';
import {
  CATALOGUE_FIELDS,
  DEFAULT_CATALOGUE_FIELDS,
  type CatalogueFieldKey,
  type CatalogueGroup,
  type CatalogueLine,
  type CatalogueScope,
  type PartsCatalogue,
} from './parts-catalogue';
import { usePartsCatalogue } from './queries';
import { useCatalogueLaunch } from './useCatalogueLaunch';

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
const LOCATION_HINT = 'Includes the chosen location **and every sub-location beneath it**.';
const PROJECT_HINT = "Lists every item on this project's **bill of materials**.";
const COLUMNS_HINT =
  'The item **name** always prints. Turn on **Line value** to total each location and the whole catalogue.';
const LOGO_HINT = 'Stored on this device only and shrunk automatically. Prints at the top of the catalogue.';
const ORG_DETAILS_HINT = 'Address or contact details. **Line breaks are kept** as you type them.';
const TITLE_HINT = 'Overrides the printed document title (the default is "Catalogue").';
const FOOTER_HINT = 'Printed at the foot of the catalogue — e.g. a confidentiality or copyright line.';

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
  // Surfaced if a picked logo can't be decoded (leaves the existing logo untouched).
  const [logoError, setLogoError] = useState('');

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

  const catalogue = usePartsCatalogue(scope);
  const selectedFields = CATALOGUE_FIELDS.filter((field) => fields.has(field.key));
  // Per-group subtotals and the grand total are only meaningful — and only shown — when the
  // costed "Line value" column is on and at least one item is actually priced.
  const showTotals = fields.has('lineValue') && (catalogue.data?.hasValue ?? false);

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

  return (
    <PageContainer>
      {/* App header + actions — dropped in print (only the document below prints). */}
      <div className="catalogue-chrome">
        <PageHeader
          icon={<CatalogueIcon />}
          title="Catalogue"
          actions={
            <Button
              variant="outline"
              onClick={() => window.print()}
              disabled={needsChoice || empty || catalogue.isLoading}
              data-testid="print-catalogue"
            >
              <PrintIcon />
              Print / Save as PDF
            </Button>
          }
        />
      </div>

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

          <fieldset>
            <legend className="mb-field-gap flex items-center gap-1.5 text-sm font-medium">
              Columns
              <InfoHint content={COLUMNS_HINT} />
            </legend>
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3 lg:grid-cols-4">
              {CATALOGUE_FIELDS.map((field) => (
                <label key={field.key} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={fields.has(field.key)}
                    onChange={() => toggleField(field.key)}
                    data-testid={`catalogue-field-${field.key}`}
                  />
                  {field.label}
                </label>
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
                <FormField label="Company name">
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

              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={branding.showGeneratedDate}
                  onChange={(e) => setCatalogueShowGeneratedDate(e.target.checked)}
                  data-testid="catalogue-branding-show-date"
                />
                Show the generated date on the printed catalogue
              </label>
            </div>
          </details>
        </Surface>

        {/* The document itself. */}
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
        ) : catalogue.isLoading ? (
          <div className="grid place-items-center py-16">
            <Spinner />
          </div>
        ) : catalogue.isError ? (
          <p role="alert" className="py-16 text-center text-sm text-destructive">
            The catalogue could not be loaded.
          </p>
        ) : empty ? (
          <p className="py-16 text-center text-sm text-muted-foreground">No items match this selection.</p>
        ) : (
          <CatalogueDocument
            catalogue={catalogue.data!}
            fields={selectedFields}
            showTotals={showTotals}
            branding={branding}
            formatters={f}
          />
        )}
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
  formatters,
}: {
  catalogue: PartsCatalogue;
  fields: readonly (typeof CATALOGUE_FIELDS)[number][];
  showTotals: boolean;
  branding: CatalogueBranding;
  formatters: Formatters;
}) {
  const f = formatters;
  const hasLetterhead = Boolean(branding.logo || branding.orgName || branding.orgDetails);
  return (
    <>
      <header className="flex flex-col gap-3 border-b border-border pb-4">
        {hasLetterhead ? (
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-0.5">
              {branding.orgName ? (
                <p className="text-base font-semibold text-foreground" data-testid="catalogue-org-name">
                  {branding.orgName}
                </p>
              ) : null}
              {branding.orgDetails ? (
                <p className="whitespace-pre-line text-sm text-muted-foreground">{branding.orgDetails}</p>
              ) : null}
            </div>
            {branding.logo ? (
              <img
                src={branding.logo}
                alt={branding.orgName ? `${branding.orgName} logo` : 'Catalogue logo'}
                className="catalogue-logo max-h-20 w-auto shrink-0 object-contain"
              />
            ) : null}
          </div>
        ) : null}

        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold" data-testid="catalogue-title">
            {branding.title || 'Catalogue'}
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
          key={group.locationId ?? 'unassigned'}
          group={group}
          fields={fields}
          showTotals={showTotals}
          formatters={f}
        />
      ))}

      {showTotals ? (
        <div className="flex items-center justify-between border-t-2 border-border pt-3 text-base font-semibold">
          <span>Total value</span>
          <Money value={catalogue.grandTotal} formatters={f} />
        </div>
      ) : null}

      {branding.footer ? (
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

/** One location group: a heading (with its subtotal when totals are shown), then the item table. */
function CatalogueGroupSection({
  group,
  fields,
  showTotals,
  formatters,
}: {
  group: CatalogueGroup;
  fields: readonly (typeof CATALOGUE_FIELDS)[number][];
  showTotals: boolean;
  formatters: Formatters;
}) {
  const f = formatters;
  return (
    <section className="flex flex-col gap-2">
      <div className="catalogue-group-heading flex flex-wrap items-baseline justify-between gap-2 border-b border-border pb-1">
        <h3 className="font-semibold">{group.locationPath}</h3>
        <span className="text-sm text-muted-foreground">
          {f.quantity(group.lines.length)} {plural(group.lines.length, 'item')}
          {showTotals ? (
            <>
              {' · subtotal '}
              <Money value={group.subtotal} formatters={f} className="font-medium text-foreground" />
            </>
          ) : null}
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="catalogue-table w-full text-sm">
          <caption className="sr-only">Items in {group.locationPath}</caption>
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
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
                    {renderField(line, field.key, f)}
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
function renderField(line: CatalogueLine, key: CatalogueFieldKey, f: Formatters): ReactNode {
  switch (key) {
    case 'category':
      return line.category ?? <Blank />;
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
  return Number.isFinite(ms) ? f.date(ms) : <Blank />;
}
