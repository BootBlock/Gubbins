import { Fragment } from 'react';
import { cn } from '@/lib/utils';
import { assertExhaustive } from '@/lib/exhaustive';
import { ColourSwatch, Money } from '@/components/foundry';
import { LinkIcon, LocalFileIcon, TagIcon, UnlinkIcon } from '@/components/icons';
import { useT } from '@/features/i18n';
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

/**
 * The box shared by the two icon-and-value arms (`link`, `pointer`).
 *
 * `max-w-full` is load-bearing, not belt-and-braces. Every other arm is a plain inline `<span>`,
 * so the parent's own `truncate` ellipsises it; these two are `inline-flex`, an *atomic* inline
 * whose shrink-to-fit width floors at its min-content width and which `text-overflow` cannot
 * ellipsise. Three of the four surfaces hide that, because there the box is a flex *item* and
 * shrinks anyway — but the table cell (`ItemTable`) is a block, where an uncapped box lays out
 * at the full width of the address and is hard-clipped mid-character with no ellipsis. Capping
 * it at the cell hands the truncation back to the inner span, which can do it.
 */
const VALUE_BOX = 'inline-flex min-w-0 max-w-full items-baseline gap-1';

/** One resolved value as JSX. `location` is tinted with its swatch class when provided. */
export function FieldValue({
  field,
  locationColorClass,
  wrap = false,
}: {
  field: ResolvedCardField;
  locationColorClass?: string;
  /**
   * Let a text value wrap over several lines instead of truncating to one.
   *
   * Off for the cards and rows, where a fixed height per configuration is the point. On for the
   * location detail panel (issue #617), which exists to *reveal* what a place records about
   * itself — clipping a long note there would reintroduce the very problem it fixes.
   */
  wrap?: boolean;
}) {
  const t = useT();
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
    case 'colour':
      // A COLOUR field (issue #452): the swatch and its hex, always together — the swatch
      // alone would carry the whole value in colour, which is exactly what WCAG 1.4.1 forbids.
      return <ColourSwatch value={value.colour} className={wrap ? 'break-words' : 'truncate'} />;
    case 'empty':
      return <span className="text-muted-foreground/60">—</span>;
    case 'measure':
      // A number and its unit (W1b). The unit takes the muted token so the value stays the
      // thing being read, and the pair stays together — truncating as one on a card or row,
      // wrapping as one on the location detail panel, so a long value never pushes its own
      // unit out of sight.
      return (
        <span className={wrap ? 'break-words' : 'truncate'}>
          {value.text}
          <span className="text-muted-foreground"> {value.unit}</span>
        </span>
      );
    case 'link':
      // An openable `URL`/`FILE` value (W1f) — the smallest form of "a custom field you can act
      // on". `target="_blank"` + `rel="noopener noreferrer"` matches the datasheet list, and the
      // card/row/table bodies already ignore a click whose origin is an `<a>`
      // (`isInteractiveDragOrigin`), so following the link never doubles as the card's own
      // click-action or the start of a drag. `title` reveals an address the card truncates.
      return (
        <a
          href={value.href}
          target="_blank"
          rel="noopener noreferrer"
          title={value.href}
          className={cn(VALUE_BOX, 'text-primary hover:underline')}
        >
          <span aria-hidden className="shrink-0 self-center [&_svg]:size-3.5">
            <LinkIcon />
          </span>
          {/* `min-w-0` so the address can be narrower than its own min-content width: without it
              a flex item never shrinks below an unbreakable URL, and `break-words` gets no line
              box narrow enough to break in. (`truncate`'s own `overflow: hidden` implies it.) */}
          <span className={cn('min-w-0', wrap ? 'break-words' : 'truncate')}>{value.href}</span>
          {/* The link's accessible name is the address itself; this appends the standard
              new-tab warning, which AT users otherwise meet only after following it. */}
          <span className="sr-only"> {t('inventory.field.link.newTab')}</span>
        </a>
      );
    case 'pointer':
      // A `FILE` value that is a path rather than a web address (W1f). Deliberately *not* an
      // anchor: a browser cannot navigate an http(s) page to `file://` or `\\server\share`, so
      // a link here would look live and do nothing. The icon says "file pointer" to sighted
      // users and the sr-only label says it to AT — see the wiki for the whole story.
      //
      // A path recorded on *another* device (W1g) swaps both (`Unlink` on the warning token,
      // and a label naming where it came from) and says so in the `title` too, since the icon
      // alone cannot carry "and that device isn't this one" to a sighted user. Both branches
      // stay one `<span>` with one truncation rule: only the two leaves differ.
      return (
        <span
          title={
            value.foreign
              ? t('inventory.field.filePointer.foreignTitle', { vars: { path: value.text } })
              : value.text
          }
          className={VALUE_BOX}
        >
          <span
            aria-hidden
            className={cn(
              'shrink-0 self-center [&_svg]:size-3.5',
              value.foreign ? 'text-warning' : 'text-muted-foreground',
            )}
          >
            {value.foreign ? <UnlinkIcon /> : <LocalFileIcon />}
          </span>
          <span className="sr-only">
            {value.foreign
              ? t('inventory.field.filePointer.foreignLabel')
              : t('inventory.field.filePointer.label')}{' '}
          </span>
          <span className={cn('min-w-0', wrap ? 'break-words' : 'truncate')}>{value.text}</span>
        </span>
      );
    case 'text':
      return (
        <span
          className={cn(
            // `break-words` so a long unbroken value (a URL, a part number) wraps rather than
            // pushing the panel wider; `pre-wrap` keeps the line breaks a LONG_TEXT value holds.
            wrap ? 'whitespace-pre-wrap break-words' : 'truncate',
            field.id === 'location' && locationColorClass,
          )}
        >
          {value.text}
        </span>
      );
    default:
      // A component has no declared return type to make the switch exhaustive on its own
      // (issue #355), so the guard is explicit: adding a `CardFieldValue` arm without a case
      // here stops compiling instead of silently rendering nothing. Out-of-band values still
      // degrade rather than crash.
      assertExhaustive(value);
      return null;
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
