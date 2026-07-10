import { useEffect, useState, type ReactNode } from 'react';
import {
  Button,
  Checkbox,
  Money,
  PageContainer,
  PageHeader,
  SelectField,
  Spinner,
  Surface,
  MAIN_CONTENT_ID,
  type SelectOption,
} from '@/components/foundry';
import { CatalogueIcon, PrintIcon } from '@/components/icons';
import type { Formatters } from '@/lib/format';
import { plural } from '@/lib/plural';
import { useFormatters } from '@/lib/useFormatters';
import { useEnabledFeatures } from '@/features/modules/useFeature';
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
        {/* Configuration panel — the scope and column pickers. Never printed. */}
        <Surface className="print-hide flex flex-col gap-5 p-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <SelectField
              label="Show"
              options={scopeOptions}
              value={scopeKind}
              onChange={(v) => setScopeKind(v as ScopeKind)}
              data-testid="catalogue-scope"
            />
            {scopeKind === 'location' ? (
              <SelectField
                label="Location"
                options={locationOptions}
                value={locationId}
                onChange={setLocationId}
                placeholder="Choose a location…"
                data-testid="catalogue-location"
              />
            ) : null}
            {scopeKind === 'project' ? (
              <SelectField
                label="Project"
                options={projectOptions}
                value={projectId}
                onChange={setProjectId}
                placeholder="Choose a project…"
                data-testid="catalogue-project"
              />
            ) : null}
          </div>

          <fieldset>
            <legend className="mb-field-gap text-sm font-medium">Columns</legend>
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
        </Surface>

        {/* The document itself. */}
        {needsChoice ? (
          <p className="py-16 text-center text-sm text-muted-foreground">
            {scopeKind === 'location'
              ? 'Choose a location to build its catalogue.'
              : scopeKind === 'project'
                ? 'Choose a project to build its parts catalogue.'
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
            formatters={f}
          />
        )}
      </main>
    </PageContainer>
  );
}

/** The document body: a title/metadata band, the location groups, and an optional total footer. */
function CatalogueDocument({
  catalogue,
  fields,
  showTotals,
  formatters,
}: {
  catalogue: PartsCatalogue;
  fields: readonly (typeof CATALOGUE_FIELDS)[number][];
  showTotals: boolean;
  formatters: Formatters;
}) {
  const f = formatters;
  return (
    <>
      <header className="flex flex-col gap-1 border-b border-border pb-4">
        <h2 className="text-lg font-semibold">Catalogue</h2>
        <p className="text-sm text-muted-foreground">
          Generated {f.date(catalogue.generatedAt)} · {f.quantity(catalogue.itemCount)}{' '}
          {plural(catalogue.itemCount, 'item')}
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
        <footer className="flex items-center justify-between border-t-2 border-border pt-3 text-base font-semibold">
          <span>Total value</span>
          <Money value={catalogue.grandTotal} formatters={f} />
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
