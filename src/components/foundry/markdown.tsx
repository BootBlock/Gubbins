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
 * - Block: headings (`#`–`####`), paragraphs, bullet / ordered lists (with indent-based
 *   nesting) and task lists (`- [ ]` / `- [x]`), blockquotes (`>`), GitHub-flavoured pipe
 *   **tables** (with per-column alignment), fenced code blocks, and horizontal rules (`---`).
 * - Inline: **bold**, *italic*, ~~strikethrough~~, `code`, [links](https://…) and bare
 *   auto-linked URLs, with `\`-escapes to show a literal marker.
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
/** Matches a bullet or ordered list item, capturing its leading indent (for nesting). */
const LIST_ITEM = /^(\s*)(?:[-*]|\d+\.)\s+/;

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
      /^(#{1,4}\s|```|>)/.test(line) ||
      LIST_ITEM.test(line) ||
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

    // List (ordered/unordered) — indent-aware, so items may nest, with optional
    // `[ ]` / `[x]` task-list checkboxes. Gathers the whole block (all consecutive list
    // lines at any depth) and builds it recursively.
    if (LIST_ITEM.test(line)) {
      const rawItems: string[] = [];
      while (i < lines.length && lines[i]!.trim() !== '' && LIST_ITEM.test(lines[i]!)) {
        rawItems.push(lines[i]!);
        i++;
      }
      blocks.push(buildList(rawItems, `list${key++}`));
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

/** One item of a list: its own text, plus any deeper-indented lines that nest beneath it. */
interface ListEntry {
  readonly content: string;
  readonly children: string[];
}

/** Leading-whitespace width of a line, used to decide list nesting depth. */
function indentOf(line: string): number {
  return LIST_ITEM.exec(line)?.[1]?.length ?? 0;
}

/**
 * Build a (possibly nested) `<ul>`/`<ol>` from a run of raw list lines. Items at this list's
 * base indent are its direct children; any deeper-indented lines are gathered under the item
 * above them and rendered as a nested list recursively.
 */
function buildList(rawItems: string[], keyBase: string): ReactNode {
  const baseIndent = Math.min(...rawItems.map(indentOf));
  const ordered = /^\s*\d+\.\s+/.test(rawItems[0] ?? '');
  const entries: ListEntry[] = [];
  for (const raw of rawItems) {
    if (indentOf(raw) <= baseIndent || entries.length === 0) {
      entries.push({ content: raw.replace(LIST_ITEM, ''), children: [] });
    } else {
      entries[entries.length - 1]!.children.push(raw);
    }
  }

  const isTaskList = !ordered && entries.every((e) => /^\[[ xX]\]\s+/.test(e.content));
  const className = ordered
    ? 'ml-4 list-decimal space-y-1'
    : cn('ml-4 space-y-1', isTaskList ? 'ml-1 list-none' : 'list-disc');

  return createElement(
    ordered ? 'ol' : 'ul',
    { key: keyBase, className },
    entries.map((entry, idx) => renderListItem(entry, `${keyBase}-${idx}`, idx)),
  );
}

/** Render one `<li>`: a leading `[ ]` / `[x]` becomes a task checkbox; children nest below. */
function renderListItem(entry: ListEntry, keyBase: string, idx: number): ReactNode {
  const nested = entry.children.length ? buildList(entry.children, `${keyBase}-sub`) : null;
  const task = /^\[([ xX])\]\s+(.*)$/.exec(entry.content);
  if (!task) {
    return (
      <li key={idx}>
        {parseInline(entry.content, keyBase)}
        {nested}
      </li>
    );
  }
  const checked = task[1]!.toLowerCase() === 'x';
  return (
    <li key={idx}>
      <span className="flex items-start gap-2">
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
      </span>
      {nested}
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
// A leading backslash-escape is matched *first* so authored docs can show a literal marker
// (`\*`, `\|`, …); a bare `http(s)://…` URL is auto-linked *last*, so an explicit
// `[label](url)` always wins over the bare form.
const INLINE =
  /(\\[\\`*_~[\]()#>|-])|(`[^`]+`)|(\*\*[\s\S]+?\*\*|__[\s\S]+?__)|(~~[\s\S]+?~~)|(\*[\s\S]+?\*|_[\s\S]+?_)|(\[[^\]]+\]\([^)]+\))|(https?:\/\/[^\s<]+)/;

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
      // Backslash escape → the literal character, with its markdown meaning suppressed.
      nodes.push(match[1]!.slice(1));
    } else if (match[2]) {
      nodes.push(
        <code
          key={key}
          className="rounded bg-secondary/70 px-1 py-0.5 font-mono text-[0.85em] text-foreground"
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else if (match[3]) {
      nodes.push(
        <strong key={key} className="font-semibold text-foreground">
          {parseInline(token.slice(2, -2), key)}
        </strong>,
      );
    } else if (match[4]) {
      nodes.push(
        <s key={key} className="text-muted-foreground">
          {parseInline(token.slice(2, -2), key)}
        </s>,
      );
    } else if (match[5]) {
      nodes.push(
        <em key={key} className="italic">
          {parseInline(token.slice(1, -1), key)}
        </em>,
      );
    } else if (match[6]) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)!;
      const href = safeHref(link[2]!);
      nodes.push(href ? renderLink(href, link[1]!, key) : link[1]!);
    } else {
      // Bare URL autolink. Trailing sentence punctuation (`.`, `)`, `,` …) almost never
      // belongs to the URL, so peel it off and emit it as plain text after the link.
      let url = token;
      let trailing = '';
      const trail = /[),.;:!?'"]+$/.exec(url);
      if (trail) {
        trailing = trail[0];
        url = url.slice(0, -trailing.length);
      }
      const href = safeHref(url);
      if (href) {
        nodes.push(renderLink(href, url, key));
        if (trailing) nodes.push(trailing);
      } else {
        nodes.push(token);
      }
    }

    rest = rest.slice(match.index + token.length);
  }

  return nodes;
}

/** A safe anchor with an unobtrusive ↗ affordance when it opens an external site. */
function renderLink(href: string, label: ReactNode, key: string): ReactNode {
  const external = /^https?:\/\//i.test(href);
  return (
    <a
      key={key}
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="font-medium text-primary underline underline-offset-2 hover:text-primary/80"
    >
      {label}
      {external ? (
        <span aria-hidden className="ml-0.5 text-[0.85em]">
          ↗
        </span>
      ) : null}
    </a>
  );
}

/**
 * Permit only safe link targets: absolute http(s), mailto, in-app absolute paths
 * (`/foo`, but not protocol-relative `//host`), anchors, and explicit relatives.
 */
function safeHref(url: string): string | undefined {
  const trimmed = url.trim();
  return /^(https?:\/\/|mailto:|\/(?!\/)|#|\.\/)/i.test(trimmed) ? trimmed : undefined;
}
