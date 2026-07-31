/**
 * The **mandatory** match picker (issue #616, phase L1).
 *
 * A search hit is never applied on the user's behalf, and this dialog is why. Searching Wikidata
 * for `Blade Runner` returns, as its *first* hit, `Q605249` — Philip K. Dick's novel *Do Androids
 * Dream of Electric Sheep?*, because "Blade Runner" is a registered alias of it. A provider that
 * took the top result would confidently fill a film's fields from a book.
 *
 * So: **even a single candidate is shown, and nothing is pre-selected.** There is no "only one
 * match, just use it" shortcut, because one match is not the same as the right match — and a
 * pre-ticked option is a choice made on the user's behalf, which is exactly what this step exists
 * to avoid.
 *
 * A candidate whose year agrees with the item's is marked, which informs that choice without
 * making it: the year is read out of the source's own description text and is best-effort, so it
 * ranks nothing and selects nothing.
 *
 * Markup is a plain `<fieldset>` of same-named native radios rather than an ARIA `radiogroup`:
 * sharing a `name` is what makes the browser enforce mutual exclusivity and give the group one
 * arrow-key-navigable tab stop, so the semantics need no ARIA on top of them.
 */
import { useEffect, useRef, useState } from 'react';
import { Button, Modal, Radio } from '@/components/foundry';
import { CheckIcon } from '@/components/icons';
import { useT } from '@/features/i18n';
import type { LookupCandidate } from '../types';

export function LookupMatchDialog({
  open,
  candidates,
  sourceName,
  itemYear,
  onChoose,
  onClose,
  isFetching = false,
}: {
  open: boolean;
  candidates: readonly LookupCandidate[];
  /** The database the candidates came from, named so the user knows what they are choosing from. */
  sourceName: string;
  /** The item's own year, when it has one — used only to mark an agreeing candidate. */
  itemYear: number | null;
  onChoose: (candidate: LookupCandidate) => void;
  onClose: () => void;
  isFetching?: boolean;
}) {
  const t = useT();
  const [chosenId, setChosenId] = useState<string | null>(null);
  const firstOptionRef = useRef<HTMLInputElement | null>(null);

  // Reset when a fresh search reopens the dialog, so a previous run's choice can't carry over to
  // a different candidate list.
  useEffect(() => {
    if (open) setChosenId(null);
  }, [open, candidates]);

  const chosen = candidates.find((candidate) => candidate.id === chosenId) ?? null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('lookup.match.title')}
      description={t('lookup.match.description', { vars: { count: candidates.length, source: sourceName } })}
      className="max-w-lg"
      initialFocusRef={firstOptionRef}
    >
      <div className="space-y-4">
        <fieldset className="space-y-2">
          <legend className="sr-only">{t('lookup.match.groupLabel')}</legend>
          {candidates.map((candidate, index) => {
            const matchesYear = itemYear !== null && candidate.year === itemYear;
            return (
              // eslint-disable-next-line jsx-a11y/label-has-associated-control -- the nested radio is correctly associated; the label's text is the dynamic candidate name, which the linter cannot resolve to a static string.
              <label
                key={candidate.id}
                className="flex cursor-pointer items-start gap-2 rounded-lg border border-border p-2 transition-colors hover:bg-muted/50 has-[:checked]:border-primary has-[:checked]:bg-primary/5"
              >
                <Radio
                  ref={index === 0 ? firstOptionRef : undefined}
                  name="lookup-candidate"
                  checked={chosenId === candidate.id}
                  onChange={() => setChosenId(candidate.id)}
                  className="mt-0.5"
                  data-testid={`lookup-candidate-${candidate.id}`}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium">{candidate.label}</span>
                    {candidate.year !== null ? (
                      <span className="text-xs text-muted-foreground">{candidate.year}</span>
                    ) : null}
                    {matchesYear ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary [&_svg]:size-3">
                        <CheckIcon aria-hidden />
                        {t('lookup.match.yearMatch')}
                      </span>
                    ) : null}
                  </span>
                  {candidate.description !== null ? (
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {candidate.description}
                    </span>
                  ) : null}
                </span>
              </label>
            );
          })}
        </fieldset>

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('lookup.cancel')}
          </Button>
          <Button
            type="button"
            onClick={() => chosen !== null && onChoose(chosen)}
            disabled={chosen === null || isFetching}
            data-testid="lookup-match-confirm"
          >
            {isFetching ? t('lookup.match.fetching') : t('lookup.match.confirm')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
