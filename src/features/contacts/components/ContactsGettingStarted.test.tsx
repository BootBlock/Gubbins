import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ContactsGettingStarted } from './ContactsGettingStarted';

afterEach(cleanup);

describe('ContactsGettingStarted', () => {
  it('renders the first-run guide panel with heading and body copy', () => {
    render(<ContactsGettingStarted />);
    const panel = screen.getByTestId('contacts-getting-started');
    expect(panel).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2 }).textContent).toContain('Welcome to Contacts');
    expect(panel.textContent).toContain('lend items to and borrow from');
    expect(panel.textContent).toContain('creates the contact automatically');
  });
});
