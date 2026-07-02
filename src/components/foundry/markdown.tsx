import { createElement, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * A tiny, dependency-free Markdown renderer (spec §2.4.3 — prioritise lean native
 * solutions over NPM bloat). It renders a trusted, app-authored Markdown string to
 * **React elements** — never via `dangerouslySetInnerHTML` — so there is no HTML
 * injection surface.
 *
 * It is deliberately not a full CommonMark implementation, but it covers the subset
 * that makes it a capable engine for **rich tooltips and in-app documentation**:
 *
 * - Block: headings (`#`–`####`), paragraphs, bullet / ordered lists, task lists
 *   (`- [ ]` / `- [x]`), blockquotes (`>`), GitHub-flavoured pipe **tables** (with
 *   per-column alignment), fenced code blocks, and horizontal rules (`---`).
 * - Inline: **bold**, *italic*, ~~strikethrough~~, `code`, and [links](https://…).
 *
 * The subset keeps the parser small, predictable and easy to unit-test.
 */
export function Markdown({ content, className }: { content: string; className?: string }) {
  return (
    <div className={cn('space-y-2 text-sm leading-relaxed text-popover-foreground', className)}>
      {renderBlocks(content)}
    </div>
  );
}

// --- Block-level parsing --------------------------------------------------------

/** Matches a thematic break: three or more `-`, `*` or `_` (optionally spaced). */
const HR = /^ {0,3}([-*_])(?: *\1){2,} *$/;
/** Matches a GFM table delimiter row, e.g. `| --- | :--: | ---: |`. */
const TABLE_DELIMITER = /^\s*\|?(?:\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/;

function renderBlocks(source: string): ReactNode[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  /** True when line `n` begins a block that must not be folded into a paragraph. */
  const startsBlock = (n: number): boolean => {
    const line = lines[n];
    if (line === undefined) return false;
    return (
      /^(#{1,4}\s|[-*]\s|\d+\.\s|```|>)/.test(line) ||
      HR.test(line) ||
      (line.includes('|') && lines[n + 1] !== undefined && TABLE_DELIMITER.test(lines[n + 1]!))
    );
  };

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim() === '') {
      i++;
      continue;
    }

    // Fenced code block.
    if (line.trim().startsWith('```')) {
      const buffer: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith('```')) {
        buffer.push(lines[i]!);
        i++;
      }
      i++; // consume the closing fence (if present)
      blocks.push(
        <pre
          key={key++}
          className="overflow-x-auto rounded-lg bg-secondary/60 p-2 font-mono text-xs text-foreground"
        >
          <code>{buffer.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    // Horizontal rule.
    if (HR.test(line)) {
      blocks.push(<hr key={key++} className="border-0 border-t border-border/80" />);
      i++;
      continue;
    }

    // GFM pipe table: a header row immediately followed by a delimiter row.
    if (line.includes('|') && i + 1 < lines.length && TABLE_DELIMITER.test(lines[i + 1]!)) {
      const header = splitRow(line);
      const aligns = splitRow(lines[i + 1]!).map(columnAlign);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim() !== '' && lines[i]!.includes('|')) {
        rows.push(splitRow(lines[i]!));
        i++;
      }
      blocks.push(renderTable(header, aligns, rows, key++));
      continue;
    }

    // Blockquote: gather consecutive `>` lines and render their content recursively.
    if (line.startsWith('>')) {
      const buffer: string[] = [];
      while (i < lines.length && lines[i]!.startsWith('>')) {
        buffer.push(lines[i]!.replace(/^>\s?/, ''));
        i++;
      }
      blocks.push(
        <blockquote
          key={key++}
          className="border-l-2 border-primary/60 pl-3 text-muted-foreground [&_p]:italic"
        >
          {renderBlocks(buffer.join('\n'))}
        </blockquote>,
      );
      continue;
    }

    // Heading (#, ##, ###, ####).
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const sizes = ['text-base', 'text-sm', 'text-sm', 'text-xs'];
      blocks.push(
        createElement(
          `h${Math.min(level + 2, 6)}`,
          { key: key++, className: cn('font-semibold text-foreground', sizes[level - 1]) },
          parseInline(heading[2]!, `h${key}`),
        ),
      );
      i++;
      continue;
    }

    // Unordered list (with optional `[ ]` / `[x]` task-list checkboxes).
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^[-*]\s+/, ''));
        i++;
      }
      const isTaskList = items.every((item) => /^\[[ xX]\]\s+/.test(item));
      blocks.push(
        <ul key={key++} className={cn('ml-4 space-y-1', isTaskList ? 'ml-1 list-none' : 'list-disc')}>
          {items.map((item, idx) => renderListItem(item, `ul${key}-${idx}`, idx))}
        </ul>,
      );
      continue;
    }

    // Ordered list.
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\d+\.\s+/, ''));
        i++;
      }
      blocks.push(
        <ol key={key++} className="ml-4 list-decimal space-y-1">
          {items.map((item, idx) => (
            <li key={idx}>{parseInline(item, `ol${key}-${idx}`)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    // Paragraph: gather consecutive plain lines (soft-wrapped into one block).
    const paragraph: string[] = [line];
    i++;
    while (i < lines.length && lines[i]!.trim() !== '' && !startsBlock(i)) {
      paragraph.push(lines[i]!);
      i++;
    }
    blocks.push(<p key={key++}>{parseInline(paragraph.join(' '), `p${key}`)}</p>);
  }

  return blocks;
}

/** Render one `<li>`, drawing a leading `[ ]` / `[x]` as a task-list checkbox. */
function renderListItem(item: string, keyBase: string, idx: number): ReactNode {
  const task = /^\[([ xX])\]\s+(.*)$/.exec(item);
  if (!task) {
    return <li key={idx}>{parseInline(item, keyBase)}</li>;
  }
  const checked = task[1]!.toLowerCase() === 'x';
  return (
    <li key={idx} className="flex items-start gap-2">
      <span
        role="img"
        aria-label={checked ? 'Done' : 'Not done'}
        className={cn(
          'mt-0.5 grid size-3.5 shrink-0 place-items-center rounded border text-[0.6rem] leading-none',
          checked ? 'border-primary bg-primary text-primary-foreground' : 'border-border text-transparent',
        )}
      >
        {checked ? '✓' : ''}
      </span>
      <span className={cn(checked && 'text-muted-foreground line-through')}>
        {parseInline(task[2]!, keyBase)}
      </span>
    </li>
  );
}

/** Split a table row on pipes, dropping the optional leading/trailing edge cells. */
function splitRow(line: string): string[] {
  const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
  return cells.map((cell) => cell.trim());
}

type ColumnAlign = 'left' | 'center' | 'right';

/** Read a delimiter cell (`:--`, `:-:`, `--:`, `---`) into its column alignment. */
function columnAlign(cell: string): ColumnAlign {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  return 'left';
}

const ALIGN_CLASS: Record<ColumnAlign, string> = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
};

function renderTable(header: string[], aligns: ColumnAlign[], rows: string[][], key: number): ReactNode {
  const alignOf = (col: number): ColumnAlign => aligns[col] ?? 'left';
  return (
    <div key={key} className="overflow-x-auto">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b border-border">
            {header.map((cell, col) => (
              <th
                key={col}
                className={cn('px-2 py-1 font-semibold text-foreground', ALIGN_CLASS[alignOf(col)])}
              >
                {parseInline(cell, `th${key}-${col}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r} className="border-b border-border/50 last:border-0">
              {header.map((_, col) => (
                <td key={col} className={cn('px-2 py-1 align-top', ALIGN_CLASS[alignOf(col)])}>
                  {parseInline(row[col] ?? '', `td${key}-${r}-${col}`)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// --- Inline parsing -------------------------------------------------------------

// Order matters: code first (its contents are literal), then bold, then strikethrough,
// then italic, then links. Non-greedy bodies keep adjacent marks from being swallowed.
const INLINE =
  /(`[^`]+`)|(\*\*[\s\S]+?\*\*|__[\s\S]+?__)|(~~[\s\S]+?~~)|(\*[\s\S]+?\*|_[\s\S]+?_)|(\[[^\]]+\]\([^)]+\))/;

function parseInline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let rest = text;
  let counter = 0;

  while (rest.length > 0) {
    const match = INLINE.exec(rest);
    if (!match) {
      nodes.push(rest);
      break;
    }
    if (match.index > 0) nodes.push(rest.slice(0, match.index));

    const token = match[0];
    const key = `${keyBase}-${counter++}`;

    if (match[1]) {
      nodes.push(
        <code
          key={key}
          className="rounded bg-secondary/70 px-1 py-0.5 font-mono text-[0.85em] text-foreground"
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else if (match[2]) {
      nodes.push(
        <strong key={key} className="font-semibold text-foreground">
          {parseInline(token.slice(2, -2), key)}
        </strong>,
      );
    } else if (match[3]) {
      nodes.push(
        <s key={key} className="text-muted-foreground">
          {parseInline(token.slice(2, -2), key)}
        </s>,
      );
    } else if (match[4]) {
      nodes.push(
        <em key={key} className="italic">
          {parseInline(token.slice(1, -1), key)}
        </em>,
      );
    } else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)!;
      const href = safeHref(link[2]!);
      nodes.push(
        href ? (
          <a
            key={key}
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            className="font-medium text-primary underline underline-offset-2 hover:text-primary/80"
          >
            {link[1]}
          </a>
        ) : (
          link[1]
        ),
      );
    }

    rest = rest.slice(match.index + token.length);
  }

  return nodes;
}

/**
 * Permit only safe link targets: absolute http(s), mailto, in-app absolute paths
 * (`/foo`, but not protocol-relative `//host`), anchors, and explicit relatives.
 */
function safeHref(url: string): string | undefined {
  const trimmed = url.trim();
  return /^(https?:\/\/|mailto:|\/(?!\/)|#|\.\/)/i.test(trimmed) ? trimmed : undefined;
}
