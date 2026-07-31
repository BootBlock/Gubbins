import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Item } from '@/db/repositories';

/**
 * Behaviour tests for {@link CategoryLookupPanel} — the whole flow's contract.
 *
 * The pure seams (binding, fill plan, provider parsers, runner) have their own exhaustive tests;
 * this pins the parts only the component decides:
 *
 * - when the affordance renders at all (and, more importantly, when it does **not**);
 * - that a search hit is never applied without the user picking it;
 * - that the direct fetch is gated by **per-host** consent, and the extension path is not;
 * - that a `CONFLICT` is withheld until it is explicitly ticked;
 * - and that an unbindable output key is *reported* rather than dropped.
 */

vi.mock('@/features/modules/useFeature', () => ({ useFeature: () => featureOn }));

const show = vi.fn();
vi.mock('@/components/foundry', async (orig) => ({
  ...(await orig<typeof import('@/components/foundry')>()),
  useToast: () => ({ show }),
}));

const bridge = {
  ready: false,
  fetchDataUrl: vi.fn(async () => null as { ok: true; body: string } | null),
};
vi.mock('@/features/scraping', () => ({ useScrapeBridge: () => bridge }));

const prefState = {
  lookupConsentHosts: [] as readonly string[],
  setLookupHostConsent: vi.fn((host: string, allowed: boolean) => {
    const next = new Set(prefState.lookupConsentHosts);
    if (allowed) next.add(host.toLowerCase());
    else next.delete(host.toLowerCase());
    prefState.lookupConsentHosts = [...next].sort();
  }),
};
vi.mock('@/state/stores/usePreferencesStore', () => ({
  usePreferencesStore: (sel: (s: typeof prefState) => unknown) => sel(prefState),
}));

interface StubField {
  id: string;
  name: string;
  fieldType: string;
  options: string[] | null;
  /** The *effective* value — stored, inherited, or the category default. */
  value: string | null;
  /** True when {@link value} is the item's own, false when it is the category's default. */
  hasStoredValue: boolean;
}

let featureOn = true;
let categoryRows: Array<{ id: string; lookupSources: Array<{ providerId: string; fieldMap: null }> }> = [];
let itemFields: StubField[] = [];
const setFieldValues = vi.fn(async () => undefined);
const updateItem = vi.fn(async () => undefined);

vi.mock('@/features/inventory/categories', () => ({
  useCategories: () => ({ data: { rows: categoryRows } }),
  useItemFields: () => ({ data: itemFields }),
  useSetItemFieldValues: () => ({ mutateAsync: setFieldValues }),
}));
vi.mock('@/features/inventory/mutations', () => ({
  useUpdateItem: () => ({ mutateAsync: updateItem }),
}));

/** A stand-in for the network: one body per request, keyed by a substring of the URL. */
let bodies: Array<{ match: string; body: string; status?: number }> = [];
const fetchMock = vi.fn(async (input: string | URL | Request) => {
  const url = String(input);
  const entry = bodies.find((b) => url.includes(b.match));
  if (entry === undefined) return new Response('{}', { status: 404 });
  return new Response(entry.body, { status: entry.status ?? 200 });
});

import { CategoryLookupPanel } from './CategoryLookupPanel';
import { LookupRunner } from '../runner';

/**
 * A runner whose rate-limit waits resolve instantly. The real `minIntervalMs` is a full second per
 * request, which every test would otherwise sit through twice — the spacing itself is pinned in
 * `runner.test.ts`, so here it is only in the way.
 */
const testRunner = () => new LookupRunner({ wait: async () => {}, now: () => 0 });

const SEARCH_BODY = JSON.stringify({
  search: [
    { id: 'Q605249', label: 'Do Androids Dream of Electric Sheep?', description: 'novel by Philip K. Dick' },
    { id: 'Q184843', label: 'Blade Runner', description: '1982 film by Ridley Scott' },
  ],
});

const detailBody = (over: Record<string, string> = {}) =>
  JSON.stringify({
    results: {
      bindings: [
        Object.fromEntries(
          Object.entries({ title: 'Blade Runner', directors: 'Ridley Scott', year: '1982', ...over }).map(
            ([k, v]) => [k, { type: 'literal', value: v }],
          ),
        ),
      ],
    },
  });

const item = {
  id: 'item-1',
  name: 'Blade Runner',
  description: null,
  categoryId: 'cat-1',
} as unknown as Item;

const withProvider = () => [
  { id: 'cat-1', lookupSources: [{ providerId: 'wikidata-film', fieldMap: null }] },
];

beforeEach(() => {
  featureOn = true;
  categoryRows = withProvider();
  itemFields = [
    { id: 'f-dir', name: 'Director', fieldType: 'TEXT', options: null, value: null, hasStoredValue: false },
  ];
  bodies = [
    { match: 'wbsearchentities', body: SEARCH_BODY },
    { match: 'query.wikidata.org', body: detailBody() },
  ];
  bridge.ready = false;
  bridge.fetchDataUrl.mockReset();
  bridge.fetchDataUrl.mockResolvedValue(null);
  prefState.lookupConsentHosts = [];
  prefState.setLookupHostConsent.mockClear();
  show.mockClear();
  setFieldValues.mockClear();
  updateItem.mockClear();
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Consent already granted for both Wikidata hosts, so the direct path runs without a prompt. */
function grantConsent(): void {
  prefState.lookupConsentHosts = ['query.wikidata.org', 'www.wikidata.org'];
}

/** Search, then pick the film (the *second* candidate) and land in the review dialog. */
async function reachReview(): Promise<void> {
  grantConsent();
  render(<CategoryLookupPanel item={item} runner={testRunner()} />);
  fireEvent.click(screen.getByTestId('lookup-start-wikidata-film'));
  await waitFor(() => expect(screen.getByTestId('lookup-candidate-Q184843')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('lookup-candidate-Q184843'));
  fireEvent.click(screen.getByTestId('lookup-match-confirm'));
  await waitFor(() => expect(screen.getByTestId('lookup-review-apply')).toBeInTheDocument());
}

describe('CategoryLookupPanel — when it renders nothing at all', () => {
  it('renders nothing when the scraping capability is off', () => {
    featureOn = false;
    render(<CategoryLookupPanel item={item} runner={testRunner()} />);
    expect(screen.queryByTestId('category-lookup-panel')).not.toBeInTheDocument();
  });

  it('renders nothing when the item has no category', () => {
    render(<CategoryLookupPanel item={{ ...item, categoryId: null } as Item} runner={testRunner()} />);
    expect(screen.queryByTestId('category-lookup-panel')).not.toBeInTheDocument();
  });

  it('renders nothing when the category has no provider attached', () => {
    categoryRows = [{ id: 'cat-1', lookupSources: [] }];
    render(<CategoryLookupPanel item={item} runner={testRunner()} />);
    expect(screen.queryByTestId('category-lookup-panel')).not.toBeInTheDocument();
  });

  it('renders nothing when the attached provider is one this build cannot run', () => {
    categoryRows = [{ id: 'cat-1', lookupSources: [{ providerId: 'from-the-future', fieldMap: null }] }];
    render(<CategoryLookupPanel item={item} runner={testRunner()} />);
    expect(screen.queryByTestId('category-lookup-panel')).not.toBeInTheDocument();
  });

  it("renders nothing when the provider's inputs aren't satisfiable", () => {
    // An unnamed item cannot be searched for, and an offer that can only fail is worse than none.
    render(<CategoryLookupPanel item={{ ...item, name: '  ' } as Item} runner={testRunner()} />);
    expect(screen.queryByTestId('category-lookup-panel')).not.toBeInTheDocument();
  });

  it('renders the control when everything lines up', () => {
    render(<CategoryLookupPanel item={item} runner={testRunner()} />);
    expect(screen.getByTestId('lookup-start-wikidata-film')).toBeInTheDocument();
  });
});

describe('CategoryLookupPanel — per-host consent gates the direct fetch', () => {
  it('asks before the first direct fetch, and sends nothing until granted', () => {
    render(<CategoryLookupPanel item={item} runner={testRunner()} />);
    fireEvent.click(screen.getByTestId('lookup-start-wikidata-film'));
    expect(screen.getByTestId('lookup-consent-confirm')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('remembers consent for every host the provider reaches, then searches', async () => {
    render(<CategoryLookupPanel item={item} runner={testRunner()} />);
    fireEvent.click(screen.getByTestId('lookup-start-wikidata-film'));
    fireEvent.click(screen.getByTestId('lookup-consent-confirm'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(prefState.setLookupHostConsent).toHaveBeenCalledWith('www.wikidata.org', true);
    expect(prefState.setLookupHostConsent).toHaveBeenCalledWith('query.wikidata.org', true);
  });

  it('declining sends nothing and leaves no consent behind', () => {
    render(<CategoryLookupPanel item={item} runner={testRunner()} />);
    fireEvent.click(screen.getByTestId('lookup-start-wikidata-film'));
    fireEvent.click(screen.getByTestId('lookup-consent-cancel'));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(prefState.lookupConsentHosts).toEqual([]);
  });

  it('does not ask again once the hosts are consented', async () => {
    grantConsent();
    render(<CategoryLookupPanel item={item} runner={testRunner()} />);
    fireEvent.click(screen.getByTestId('lookup-start-wikidata-film'));
    expect(screen.queryByTestId('lookup-consent-confirm')).not.toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });

  it('uses the extension without asking for consent at all when it is present', async () => {
    // The extension is a privileged, user-installed component with its own declared host
    // permissions, so the app is not the one reaching the network on this path.
    bridge.ready = true;
    bridge.fetchDataUrl.mockResolvedValue({ ok: true, body: SEARCH_BODY });
    render(<CategoryLookupPanel item={item} runner={testRunner()} />);
    fireEvent.click(screen.getByTestId('lookup-start-wikidata-film'));

    await waitFor(() => expect(screen.getByTestId('lookup-candidate-Q184843')).toBeInTheDocument());
    expect(bridge.fetchDataUrl).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(prefState.lookupConsentHosts).toEqual([]);
  });

  it('does not fall back to a direct fetch when a present extension fails to answer', async () => {
    // A silent fallback would cross to the network on a path the user has not consented to.
    bridge.ready = true;
    bridge.fetchDataUrl.mockResolvedValue(null);
    render(<CategoryLookupPanel item={item} runner={testRunner()} />);
    fireEvent.click(screen.getByTestId('lookup-start-wikidata-film'));

    await waitFor(() => expect(show).toHaveBeenCalled());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('CategoryLookupPanel — the match picker is mandatory', () => {
  it('shows the candidates and applies nothing until one is chosen', async () => {
    grantConsent();
    render(<CategoryLookupPanel item={item} runner={testRunner()} />);
    fireEvent.click(screen.getByTestId('lookup-start-wikidata-film'));

    await waitFor(() => expect(screen.getByTestId('lookup-candidate-Q184843')).toBeInTheDocument());
    // The novel is genuinely the first hit; both are offered and neither is pre-selected.
    expect(screen.getByTestId('lookup-candidate-Q605249')).toBeInTheDocument();
    expect(screen.getByTestId('lookup-candidate-Q605249')).not.toBeChecked();
    expect(screen.getByTestId('lookup-candidate-Q184843')).not.toBeChecked();
    // Confirm is unusable until the user picks, and no detail fetch has run.
    expect(screen.getByTestId('lookup-match-confirm')).toBeDisabled();
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes('query.wikidata.org'))).toBe(true);
  });

  it('shows a single candidate too, rather than using it automatically', async () => {
    bodies = [
      {
        match: 'wbsearchentities',
        body: JSON.stringify({ search: [{ id: 'Q184843', label: 'Blade Runner' }] }),
      },
      { match: 'query.wikidata.org', body: detailBody() },
    ];
    grantConsent();
    render(<CategoryLookupPanel item={item} runner={testRunner()} />);
    fireEvent.click(screen.getByTestId('lookup-start-wikidata-film'));

    await waitFor(() => expect(screen.getByTestId('lookup-candidate-Q184843')).toBeInTheDocument());
    expect(screen.getByTestId('lookup-match-confirm')).toBeDisabled();
  });

  it('warns and applies nothing when the search matches nothing', async () => {
    bodies = [{ match: 'wbsearchentities', body: JSON.stringify({ search: [] }) }];
    grantConsent();
    render(<CategoryLookupPanel item={item} runner={testRunner()} />);
    fireEvent.click(screen.getByTestId('lookup-start-wikidata-film'));

    await waitFor(() => expect(show).toHaveBeenCalled());
    expect(screen.queryByTestId('lookup-match-confirm')).not.toBeInTheDocument();
    expect(setFieldValues).not.toHaveBeenCalled();
  });
});

describe('CategoryLookupPanel — reviewing and applying', () => {
  it('fills an empty field and the built-in name, and reports what had no field', async () => {
    await reachReview();
    // Only "Director" exists on this category, so the other output keys are reported rather than
    // silently dropped — the user is told there is nowhere for them to go.
    expect(screen.getByText(/no “Cast” field|no "Cast" field/i)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('lookup-review-apply'));
    await waitFor(() => expect(setFieldValues).toHaveBeenCalledWith({ 'f-dir': 'Ridley Scott' }));
    // The item is already named "Blade Runner", so the built-in is UNCHANGED and never written.
    expect(updateItem).not.toHaveBeenCalled();
  });

  it('withholds a conflicting value until that specific field is ticked', async () => {
    itemFields = [
      {
        id: 'f-dir',
        name: 'Director',
        fieldType: 'TEXT',
        options: null,
        value: 'Denis Villeneuve',
        hasStoredValue: true,
      },
    ];
    await reachReview();

    // Nothing to fill and one conflict left unticked → Apply is unusable.
    expect(screen.getByTestId('lookup-review-apply')).toBeDisabled();
    fireEvent.click(screen.getByTestId('lookup-overwrite-director'));
    fireEvent.click(screen.getByTestId('lookup-review-apply'));
    await waitFor(() => expect(setFieldValues).toHaveBeenCalledWith({ 'f-dir': 'Ridley Scott' }));
  });

  it('offers no Apply when a category’s fields match nothing the source returned', async () => {
    // No field is named after any output key, and the item already carries the title, so there is
    // genuinely nothing to write — the dialog says so and refuses rather than writing an empty patch.
    itemFields = [
      { id: 'f-blurb', name: 'Blurb', fieldType: 'TEXT', options: null, value: null, hasStoredValue: false },
    ];
    await reachReview();
    expect(screen.getByTestId('lookup-review-apply')).toBeDisabled();
    // …and every unbindable key is named back to the user rather than dropped.
    expect(screen.getByText(/“Director”/)).toBeInTheDocument();
    expect(screen.getByText(/“Cast”/)).toBeInTheDocument();
  });

  it('reports a type mismatch rather than coercing the value into the wrong field', async () => {
    itemFields = [
      { id: 'f-year', name: 'Release year', fieldType: 'TEXT', options: null, value: null },
      { id: 'f-dir', name: 'Director', fieldType: 'TEXT', options: null, value: null },
    ];
    await reachReview();
    expect(
      screen.getByText(/“Release year” is a text field, but this value is a number/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('lookup-review-apply'));
    // The director still lands; one unusable key never blocks the rest.
    await waitFor(() => expect(setFieldValues).toHaveBeenCalledWith({ 'f-dir': 'Ridley Scott' }));
  });

  it('renames the item when the source has a different title and the user opts in', async () => {
    bodies = [
      { match: 'wbsearchentities', body: SEARCH_BODY },
      { match: 'query.wikidata.org', body: detailBody({ title: 'Blade Runner: The Final Cut' }) },
    ];
    await reachReview();
    fireEvent.click(screen.getByTestId('lookup-overwrite-title'));
    fireEvent.click(screen.getByTestId('lookup-review-apply'));
    await waitFor(() =>
      expect(updateItem).toHaveBeenCalledWith({
        id: 'item-1',
        input: { name: 'Blade Runner: The Final Cut' },
      }),
    );
  });

  it('fills a field that is only showing its category default, rather than calling it a conflict', async () => {
    // A resolved field's `value` is the *effective* one, so a category default arrives looking
    // exactly like a value the user typed. Treating it as a conflict would break the dialog's own
    // promise that "empty fields are filled automatically".
    itemFields = [
      {
        id: 'f-dir',
        name: 'Director',
        fieldType: 'TEXT',
        options: null,
        value: 'Unknown',
        hasStoredValue: false,
      },
    ];
    await reachReview();
    // No tick required — it is a FILL, so Apply is live immediately.
    expect(screen.getByTestId('lookup-review-apply')).not.toBeDisabled();
    expect(screen.queryByTestId('lookup-overwrite-director')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('lookup-review-apply'));
    await waitFor(() => expect(setFieldValues).toHaveBeenCalledWith({ 'f-dir': 'Ridley Scott' }));
  });

  it('keeps the reviewed plan on screen when the write fails', async () => {
    setFieldValues.mockRejectedValueOnce(new Error('storage hard stop'));
    await reachReview();
    fireEvent.click(screen.getByTestId('lookup-review-apply'));
    await waitFor(() => expect(setFieldValues).toHaveBeenCalled());
    expect(screen.getByTestId('lookup-review-apply')).toBeInTheDocument();
  });

  it('returns to the picker, not to the start, when a chosen candidate has no details', async () => {
    bodies = [
      { match: 'wbsearchentities', body: SEARCH_BODY },
      { match: 'query.wikidata.org', body: JSON.stringify({ results: { bindings: [] } }) },
    ];
    grantConsent();
    render(<CategoryLookupPanel item={item} runner={testRunner()} />);
    fireEvent.click(screen.getByTestId('lookup-start-wikidata-film'));
    await waitFor(() => expect(screen.getByTestId('lookup-candidate-Q605249')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('lookup-candidate-Q605249'));
    fireEvent.click(screen.getByTestId('lookup-match-confirm'));

    await waitFor(() => expect(show).toHaveBeenCalled());
    // The candidate list is still valid; the likely next move is the entry beside this one.
    expect(screen.getByTestId('lookup-candidate-Q184843')).toBeInTheDocument();
  });
});

describe('CategoryLookupPanel — the fieldMap override', () => {
  it('fills the mapped field rather than the one the provider names by default', async () => {
    itemFields = [
      {
        id: 'f-helm',
        name: 'Helmed by',
        fieldType: 'TEXT',
        options: null,
        value: null,
        hasStoredValue: false,
      },
    ];
    categoryRows = [
      {
        id: 'cat-1',
        lookupSources: [
          { providerId: 'wikidata-film', fieldMap: { director: 'f-helm' } } as unknown as {
            providerId: string;
            fieldMap: null;
          },
        ],
      },
    ];
    await reachReview();
    fireEvent.click(screen.getByTestId('lookup-review-apply'));
    await waitFor(() => expect(setFieldValues).toHaveBeenCalledWith({ 'f-helm': 'Ridley Scott' }));
  });
});
