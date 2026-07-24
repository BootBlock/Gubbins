import { Fragment } from 'react';
import { cn } from '@/lib/utils';
import { Money } from '@/components/foundry';
import { TagIcon } from '@/components/icons';
import type { ResolvedCardField } from '../card-fields';
import { CONDITION_COLOR_CLASS, CONDITION_LABELS } from './inventory-ui';

/**
 * The JSX for the configurable item-card fields (backlog E1). The pure `card-fields.ts` seam
 * resolves one item into ordered `{ label, value }` descriptors (via `useResolvedCardFields`
 * in `card-fields-render.ts`); this turns each value into token-correct JSX — the Foundry
 * `Money` control for a price, the `text-cond-*` tint for a condition — so the design-token
 * house rules aren't bypassed. Two layouts share the value renderer: a two-column definition
 * list for the Visual card (every field on its own row, so a card's height depends only on the
 * configuration), and a compact inline summary for the dense Data row (single truncated line,
 * empties omitted).
 */

/** One resolved value as JSX. `location` is tinted with its swatch class when provided. */
export function FieldValue({
  field,
  locationColorClass,
}: {
  field: ResolvedCardField;
  locationColorClass?: string;
}) {
  const value = field.value;
  switch (value.kind) {
    case 'money':
      return <Money value={value.amount} className="tabular-nums" />;
    case 'condition':
      return (
        <span className={CONDITION_COLOR_CLASS[value.condition]}>{CONDITION_LABELS[value.condition]}</span>
      );
    case 'tags':
      // A wrapping row of chips (issue #84). `justify-end` keeps them right-aligned in the
      // Visual card's value column; in the Data row summary they flow inline with the middots.
      return (
        <span className="flex flex-wrap justify-end gap-1">
          {value.tags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-0.5 rounded-full bg-primary/15 px-1.5 py-0.5 text-[0.65rem] font-medium leading-none text-primary [&_svg]:size-2.5"
            >
              <TagIcon aria-hidden />
              {tag}
            </span>
          ))}
        </span>
      );
    case 'image':
      // A custom-field cover (issue #453): a small bounded thumbnail; the base64 data: URL
      // is the value itself, so there is nothing to fetch.
      return <img src={value.src} alt={field.label} className="max-h-8 rounded object-contain" />;
    case 'empty':
      return <span className="text-muted-foreground/60">—</span>;
    case 'text':
      return (
        <span className={cn('truncate', field.id === 'location' && locationColorClass)}>{value.text}</span>
      );
  }
}

/** The Visual card's field block — a labelled two-column list; fixed row count per config. */
export function CardFieldList({
  fields,
  locationColorClass,
}: {
  fields: readonly ResolvedCardField[];
  locationColorClass?: string;
}) {
  if (fields.length === 0) return null;
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1 text-xs">
      {fields.map((field) => (
        <Fragment key={field.id}>
          <dt className="truncate text-muted-foreground">{field.label}</dt>
          <dd className="flex min-w-0 justify-end truncate text-right font-medium text-foreground">
            <FieldValue field={field} locationColorClass={locationColorClass} />
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

/** The Data row's compact one-line field summary — values only, middot-separated, empties dropped. */
export function CardFieldSummary({
  fields,
  locationColorClass,
}: {
  fields: readonly ResolvedCardField[];
  locationColorClass?: string;
}) {
  const shown = fields.filter((f) => f.value.kind !== 'empty');
  if (shown.length === 0) return null;
  // The line is muted; only the location value takes its swatch tint (handled in FieldValue).
  return (
    <p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
      {shown.map((field, index) => (
        <Fragment key={field.id}>
          {index > 0 ? (
            <span aria-hidden className="text-muted-foreground/40">
              ·
            </span>
          ) : null}
          <FieldValue field={field} locationColorClass={locationColorClass} />
        </Fragment>
      ))}
    </p>
  );
}
