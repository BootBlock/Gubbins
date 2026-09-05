import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { useModulesStore } from '@/state/stores/useModulesStore';
import { ActivityActor } from './ActivityActor';

/**
 * The "who" line on an activity entry (issue #774).
 *
 * Three decisions live here and nowhere else, which is why they are tested here rather than
 * four times over in the surfaces that render it: whether the line appears at all, what it says
 * when the account can be named, and what it says when it cannot.
 */
describe('ActivityActor (issue #774)', () => {
  beforeEach(() => {
    useModulesStore.setState({ intent: {} });
  });

  afterEach(cleanup);

  it('says nothing while accounts are off, where every entry names the same account', () => {
    // `users` is `defaultOff`, so an empty intent is the single-person setup.
    render(<ActivityActor actorDisplayName="Admin" />);
    expect(screen.queryByTestId('activity-actor')).toBeNull();
  });

  it('names the account once accounts are on', () => {
    useModulesStore.getState().setFeatureIntent('users', true);
    render(<ActivityActor actorDisplayName="Ada Okafor" />);
    expect(screen.getByTestId('activity-actor')).toHaveTextContent('by Ada Okafor');
  });

  it('says the account is gone rather than inventing a name for it', () => {
    useModulesStore.getState().setFeatureIntent('users', true);
    render(<ActivityActor actorDisplayName={null} />);
    expect(screen.getByTestId('activity-actor')).toHaveTextContent('no longer exists');
  });
});
