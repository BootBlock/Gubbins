import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { SuppliersGettingStarted } from './SuppliersGettingStarted';

afterEach(cleanup);

describe('SuppliersGettingStarted', () => {
  it('renders the first-run guide panel with heading and body copy', () => {
    render(<SuppliersGettingStarted />);
    const panel = screen.getByTestId('suppliers-getting-started');
    expect(panel).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3 }).textContent).toContain('Welcome to Suppliers');
    expect(panel.textContent).toContain('one shared list');
    expect(panel.textContent).toContain('Merge suppliers');
  });
});
