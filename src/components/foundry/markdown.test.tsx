import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { Markdown } from './markdown';

afterEach(cleanup);

describe('Markdown renderer', () => {
  it('renders bold, italic and inline code as elements (not raw markup)', () => {
    const { container } = render(<Markdown content="A **bold** and *italic* and `code` word." />);
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.querySelector('em')?.textContent).toBe('italic');
    expect(container.querySelector('code')?.textContent).toBe('code');
    // No literal asterisks/backticks should survive in the text.
    expect(container.textContent).not.toContain('**');
    expect(container.textContent).not.toContain('`');
  });

  it('renders safe links with security attributes and drops unsafe schemes', () => {
    render(<Markdown content="[ok](https://example.com) and [bad](javascript:alert(1))" />);
    const link = screen.getByRole('link', { name: 'ok' });
    expect(link).toHaveAttribute('href', 'https://example.com');
    expect(link).toHaveAttribute('rel', 'noreferrer noopener');
    // The unsafe link renders as plain text, not an anchor.
    expect(screen.queryByRole('link', { name: 'bad' })).toBeNull();
    expect(screen.getByText(/bad/)).toBeInTheDocument();
  });

  it('rejects protocol-relative links but allows absolute in-app paths', () => {
    render(<Markdown content="[evil](//evil.com) and [home](/inventory)" />);
    expect(screen.queryByRole('link', { name: 'evil' })).toBeNull();
    expect(screen.getByRole('link', { name: 'home' })).toHaveAttribute('href', '/inventory');
  });

  it('renders bullet lists', () => {
    const { container } = render(<Markdown content={'- one\n- two\n- three'} />);
    expect(container.querySelectorAll('ul li')).toHaveLength(3);
  });

  it('nests indented list items under their parent', () => {
    const { container } = render(<Markdown content={'- Fruit\n  - Apple\n  - Pear\n- Veg'} />);
    // One outer list with a single nested list beneath the first item.
    expect(container.querySelectorAll('ul')).toHaveLength(2);
    expect(container.querySelectorAll('ul ul')).toHaveLength(1);
    expect(container.querySelectorAll('ul ul li')).toHaveLength(2);
    // Two top-level items survive alongside the nested pair.
    const outer = container.querySelector('ul')!;
    const topItems = Array.from(outer.children).filter((el) => el.tagName === 'LI');
    expect(topItems).toHaveLength(2);
    expect(topItems[0]?.textContent).toContain('Apple');
    expect(topItems[1]?.textContent).toBe('Veg');
  });

  it('nests an ordered list inside an unordered one', () => {
    const { container } = render(<Markdown content={'- Steps\n  1. First\n  2. Second'} />);
    const nested = container.querySelector('ul ol');
    expect(nested).toBeInTheDocument();
    expect(nested?.querySelectorAll('li')).toHaveLength(2);
  });

  it('renders headings and fenced code blocks', () => {
    const { container } = render(<Markdown content={'# Title\n\n```\nplain\n```'} />);
    expect(container.querySelector('h3')?.textContent).toBe('Title');
    expect(container.querySelector('pre code')?.textContent).toBe('plain');
  });

  it('groups soft-wrapped lines into one paragraph', () => {
    const { container } = render(<Markdown content={'line one\nline two\n\nsecond para'} />);
    const paras = container.querySelectorAll('p');
    expect(paras).toHaveLength(2);
    expect(paras[0]?.textContent).toBe('line one line two');
  });

  it('renders strikethrough as an <s> element', () => {
    const { container } = render(<Markdown content="This is ~~gone~~ now." />);
    expect(container.querySelector('s')?.textContent).toBe('gone');
    expect(container.textContent).not.toContain('~~');
  });

  it('renders a horizontal rule from ---', () => {
    const { container } = render(<Markdown content={'above\n\n---\n\nbelow'} />);
    expect(container.querySelector('hr')).toBeInTheDocument();
    // The rule must not be mistaken for a list bullet or swallowed into a paragraph.
    expect(container.querySelectorAll('p')).toHaveLength(2);
  });

  it('renders a GFM pipe table with a header and body cells', () => {
    const md = ['| Name | Qty |', '| --- | ---: |', '| Resistor | 100 |', '| Capacitor | 42 |'].join('\n');
    const { container } = render(<Markdown content={md} />);
    const table = container.querySelector('table');
    expect(table).toBeInTheDocument();
    expect(container.querySelectorAll('thead th')).toHaveLength(2);
    expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(screen.getByRole('columnheader', { name: 'Name' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Resistor' })).toBeInTheDocument();
  });

  it('applies per-column alignment from the delimiter row', () => {
    const md = ['| L | C | R |', '| :-- | :-: | --: |', '| a | b | c |'].join('\n');
    const { container } = render(<Markdown content={md} />);
    const headers = container.querySelectorAll('thead th');
    expect(headers[0]?.className).toContain('text-left');
    expect(headers[1]?.className).toContain('text-center');
    expect(headers[2]?.className).toContain('text-right');
  });

  it('renders inline marks inside table cells', () => {
    const md = ['| Field | Note |', '| --- | --- |', '| id | **required** |'].join('\n');
    const { container } = render(<Markdown content={md} />);
    expect(container.querySelector('td strong')?.textContent).toBe('required');
  });

  it('renders a blockquote with its inner markdown', () => {
    const { container } = render(<Markdown content={'> **Note:** save often.'} />);
    const quote = container.querySelector('blockquote');
    expect(quote).toBeInTheDocument();
    expect(quote?.querySelector('strong')?.textContent).toBe('Note:');
  });

  it('renders a task list with checked/unchecked state', () => {
    const { container } = render(<Markdown content={'- [x] done\n- [ ] todo'} />);
    // No literal bracket syntax survives in the text.
    expect(container.textContent).not.toContain('[x]');
    expect(container.textContent).not.toContain('[ ]');
    expect(screen.getByLabelText('Done')).toBeInTheDocument();
    expect(screen.getByLabelText('Not done')).toBeInTheDocument();
  });

  it('renders headings up to level four', () => {
    const { container } = render(<Markdown content={'#### Deep'} />);
    expect(container.querySelector('h6')?.textContent).toBe('Deep');
  });

  it('honours backslash escapes for literal markers', () => {
    const { container } = render(<Markdown content={'2 \\* 3 and \\`code\\` and a \\| pipe'} />);
    // The escaped asterisk/backticks/pipe must survive as literal text, un-parsed.
    expect(container.querySelector('em')).toBeNull();
    expect(container.querySelector('code')).toBeNull();
    expect(container.textContent).toBe('2 * 3 and `code` and a | pipe');
  });

  it('auto-links a bare URL and peels trailing punctuation', () => {
    render(<Markdown content="See https://example.com/docs. Thanks." />);
    const link = screen.getByRole('link', { name: /example\.com\/docs/ });
    expect(link).toHaveAttribute('href', 'https://example.com/docs');
    // The trailing full stop is text, not part of the link.
    expect(link).not.toHaveAttribute('href', 'https://example.com/docs.');
    expect(screen.getByText(/Thanks\./)).toBeInTheDocument();
  });

  it('marks external links with an aria-hidden ↗ affordance but not in-app links', () => {
    render(<Markdown content="[out](https://example.com) and [in](/inventory)" />);
    const external = screen.getByRole('link', { name: 'out' });
    const internal = screen.getByRole('link', { name: 'in' });
    // The arrow is decorative (aria-hidden) so the accessible name stays clean.
    expect(external.querySelector('[aria-hidden]')?.textContent).toBe('↗');
    expect(internal.querySelector('[aria-hidden]')).toBeNull();
  });
});
