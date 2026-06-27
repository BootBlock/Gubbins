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
    render(
      <Markdown content="[ok](https://example.com) and [bad](javascript:alert(1))" />,
    );
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
});
