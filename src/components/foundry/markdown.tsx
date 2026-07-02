import { createElement, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * A tiny, dependency-free Markdown renderer (spec §2.4.3 — prioritise lean native
 * solutions over NPM bloat). It renders a trusted, app-authored Markdown string to
 * **React elements** — never via `dangerouslySetInnerHTML` — so there is no HTML
 * injection surface. It deliberately supports a focused subset suited to rich
 * tooltips and help text: paragraphs, headings, bullet/ordered lists, fenced code
 * blocks, and the inline marks **bold**, *italic*, `code` and [links](https://…).
 *
 * It is intentionally not a full CommonMark implementation; the subset keeps the
 * parser small, predictable and easy to unit-test.
 */
export function Markdown({ content, className }: { content: string; className?: string }) {
  return (
    <div className={cn('space-y-2 text-sm leading-relaxed text-popover-foreground', className)}>
      {renderBlocks(content)}
    </div>
  );
}

// --- Block-level parsing --------------------------------------------------------

function renderBlocks(source: string): ReactNode[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  const isSpecial = (line: string) => /^(#{1,3}\s|[-*]\s|\d+\.\s|```)/.test(line);

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

    // Heading (#, ##, ###).
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const sizes = ['text-base', 'text-sm', 'text-sm'];
      blocks.push(
        createElement(
          `h${level + 2}`,
          { key: key++, className: cn('font-semibold text-foreground', sizes[level - 1]) },
          parseInline(heading[2]!, `h${key}`),
        ),
      );
      i++;
      continue;
    }

    // Unordered list.
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^[-*]\s+/, ''));
        i++;
      }
      blocks.push(
        <ul key={key++} className="ml-4 list-disc space-y-1">
          {items.map((item, idx) => (
            <li key={idx}>{parseInline(item, `ul${key}-${idx}`)}</li>
          ))}
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
    while (i < lines.length && lines[i]!.trim() !== '' && !isSpecial(lines[i]!)) {
      paragraph.push(lines[i]!);
      i++;
    }
    blocks.push(<p key={key++}>{parseInline(paragraph.join(' '), `p${key}`)}</p>);
  }

  return blocks;
}

// --- Inline parsing -------------------------------------------------------------

// Order matters: code first (its contents are literal), then bold, then italic,
// then links. Non-greedy bodies keep adjacent marks from being swallowed.
const INLINE = /(`[^`]+`)|(\*\*[\s\S]+?\*\*|__[\s\S]+?__)|(\*[\s\S]+?\*|_[\s\S]+?_)|(\[[^\]]+\]\([^)]+\))/;

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
