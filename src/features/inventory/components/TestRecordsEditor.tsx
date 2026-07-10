/**
 * TestRecordsEditor — per-instance test / calibration / service records for one item (feature-gap G7).
 *
 * A structured pass/fail + reading log for a **serialised** unit (InvenTree "test result" parity) —
 * the QA audit trail a lab / maker / calibration house keeps against a serial number, beyond the
 * free-form maintenance history. Only meaningful for a serialised item, so the surface is gated to
 * `SERIALISED` tracking at the tab-building layer (see `ItemDetailDialog.buildTabs`).
 *
 * All vocabulary + validation + aggregation lives in the pure `test-records.ts` seam
 * (`planTestRecord` / `summariseTestRecords` / `sortTestRecords`); this component is the
 * Foundry-primitive glue. Design tokens only (result tone via semantic status tokens), WCAG 4.1.3
 * live regions, field-anchored reviewable errors.
 */
import { useEffect, useMemo, useState } from 'react';
import { Button, InfoHint, Input, LiveRegion, SelectField } from '@/components/foundry';
import { AddIcon, DeleteIcon, TestRecordIcon } from '@/components/icons';
import type { Item } from '@/db/repositories';
import { cn } from '@/lib/utils';
import { useFormatters } from '@/lib/useFormatters';
import { useItemTestRecords } from '../queries';
import { useRecordTestResult, useRemoveTestRecord } from '../mutations';
import {
  TEST_RECORD_KIND_LABELS,
  TEST_RECORD_KIND_OPTIONS,
  TEST_RESULT_LABELS,
  TEST_RESULT_OPTIONS,
  TEST_RESULT_TONE,
  planTestRecord,
  sortTestRecords,
  summariseTestRecords,
  type TestRecordPlanError,
  type TestResultTone,
} from '../test-records';
import { fromDateInputValue } from './inventory-ui';

/** Design-token status tone for each result badge (semantic tokens, dark-mode-correct). */
const TONE_CLASS: Record<TestResultTone, string> = {
  positive: 'text-success',
  negative: 'text-destructive',
  warning: 'text-warning',
  neutral: 'text-muted-foreground',
};

/** Which field each validation error anchors its message to. */
const ERROR_FIELD: Record<TestRecordPlanError, 'name' | 'reading'> = {
  EMPTY_NAME: 'name',
  INVALID_READING: 'reading',
};

const ERROR_MESSAGE: Record<TestRecordPlanError, string> = {
  EMPTY_NAME: 'A test name is required.',
  INVALID_READING: 'The reading must be a number, or leave it blank.',
};

export function TestRecordsEditor({ item }: { item: Item }) {
  const fmt = useFormatters();
  const { data: records } = useItemTestRecords(item.id);
  const record = useRecordTestResult();
  const removeRecord = useRemoveTestRecord();

  const [kind, setKind] = useState<string>('TEST');
  const [name, setName] = useState('');
  const [result, setResult] = useState<string>('PASS');
  const [reading, setReading] = useState('');
  const [unit, setUnit] = useState('');
  const [note, setNote] = useState('');
  const [date, setDate] = useState('');
  const [error, setError] = useState<TestRecordPlanError | null>(null);

  // Reset the draft when switching item.
  useEffect(() => {
    setKind('TEST');
    setName('');
    setResult('PASS');
    setReading('');
    setUnit('');
    setNote('');
    setDate('');
    setError(null);
  }, [item.id]);

  const sorted = useMemo(() => sortTestRecords(records ?? []), [records]);
  const summary = useMemo(() => summariseTestRecords(records ?? []), [records]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    // A blank reading is "no reading"; any text becomes a number the seam validates (NaN → rejected).
    const trimmedReading = reading.trim();
    const draft = {
      kind,
      name,
      result,
      reading: trimmedReading === '' ? null : Number(trimmedReading),
      unit,
      note,
    };
    const plan = planTestRecord(draft);
    if (!plan.ok) {
      setError(plan.reason);
      return;
    }
    setError(null);
    record.mutate(
      { id: item.id, input: { ...draft, performedAt: fromDateInputValue(date) ?? undefined } },
      {
        onSuccess: () => {
          setName('');
          setReading('');
          setUnit('');
          setNote('');
          setDate('');
        },
      },
    );
  };

  const fieldError = (field: 'name' | 'reading'): string | undefined =>
    error != null && ERROR_FIELD[error] === field ? ERROR_MESSAGE[error] : undefined;

  return (
    <section className="space-y-3" aria-label="Test & calibration records">
      {/* The Section card already titles this facet, so lead with a caption + help rather than
          repeating the heading. */}
      <div className="flex items-start justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          Structured pass/fail &amp; reading log for this unit.
          <InfoHint
            content={
              'A structured **pass/fail + reading log** for this serialised unit — the QA audit trail ' +
              'for a lab / maker / calibration house, beyond the free-form maintenance history.\n\n' +
              'Each record has a **kind** (test / calibration / service), a **result** ' +
              '(pass / fail / marginal / no verdict) and an optional numeric **reading** with a unit ' +
              '(e.g. `12.5 MΩ`).'
            }
          />
        </p>
        {summary.count > 0 ? (
          <p
            className="shrink-0 text-xs text-muted-foreground"
            aria-live="polite"
            data-testid="test-records-summary"
          >
            {summary.count} {summary.count === 1 ? 'record' : 'records'}
            {summary.latestResult ? (
              <>
                {' · latest '}
                <span className={cn('font-medium', TONE_CLASS[TEST_RESULT_TONE[summary.latestResult]])}>
                  {TEST_RESULT_LABELS[summary.latestResult]}
                </span>
              </>
            ) : null}
            {summary.failCount > 0 ? (
              <span className="text-destructive">
                {' · '}
                {summary.failCount} failed
              </span>
            ) : null}
          </p>
        ) : null}
      </div>

      {/* Record a new result. */}
      <form onSubmit={submit} className="grid grid-cols-2 gap-3" data-testid="test-record-form">
        <SelectField
          label="Kind"
          value={kind}
          onChange={setKind}
          options={TEST_RECORD_KIND_OPTIONS}
          data-testid="test-record-kind"
        />
        <SelectField
          label="Result"
          value={result}
          onChange={setResult}
          options={TEST_RESULT_OPTIONS}
          data-testid="test-record-result"
        />

        <div className="col-span-2">
          <TField label="Test name" error={fieldError('name')}>
            <Input
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (error === 'EMPTY_NAME') setError(null);
              }}
              placeholder="e.g. Insulation resistance"
              aria-label="Test name"
              data-testid="test-record-name"
            />
          </TField>
        </div>

        <TField
          label="Reading (optional)"
          error={fieldError('reading')}
          hint="An optional measured value — may be negative (temperature, drift, dBm)."
        >
          <Input
            type="number"
            step="any"
            inputMode="decimal"
            value={reading}
            onChange={(e) => {
              setReading(e.target.value);
              if (error === 'INVALID_READING') setError(null);
            }}
            placeholder="—"
            aria-label="Reading"
            data-testid="test-record-reading"
          />
        </TField>

        <TField label="Unit (optional)" hint="The reading’s unit, e.g. MΩ, V, °C. Kept only with a reading.">
          <Input
            type="text"
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            placeholder="e.g. MΩ"
            aria-label="Unit"
            data-testid="test-record-unit"
          />
        </TField>

        <div className="col-span-2">
          <TField label="Note (optional)">
            <Input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. tested at 500 V DC"
              aria-label="Test note"
              data-testid="test-record-note"
            />
          </TField>
        </div>

        <TField label="Performed on" hint="Defaults to today when left blank.">
          <Input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            aria-label="Date performed"
            data-testid="test-record-date"
          />
        </TField>

        <div className="col-span-2 flex justify-end">
          <Button type="submit" size="sm" disabled={record.isPending} data-testid="record-test-result">
            <AddIcon />
            Record result
          </Button>
        </div>
      </form>

      {/* Records, newest first. */}
      {sorted.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="test-records-empty">
          No test records yet. Log a pass/fail check, a calibration or a service against this unit.
        </p>
      ) : (
        <ul className="flex flex-col gap-1" data-testid="test-records-list">
          {sorted.map((r) => (
            <li
              key={r.id}
              className="flex items-center gap-2 rounded-lg bg-secondary/30 px-2.5 py-1.5 text-sm"
              data-testid="test-record-row"
            >
              <span className="flex items-center gap-1.5 [&_svg]:size-3.5 [&_svg]:text-muted-foreground">
                <TestRecordIcon aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="truncate font-medium">{r.name}</span>
                  <span
                    className={cn('text-xs font-semibold', TONE_CLASS[TEST_RESULT_TONE[r.result]])}
                    data-testid="test-record-result-badge"
                  >
                    {TEST_RESULT_LABELS[r.result]}
                  </span>
                  {r.reading != null ? (
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {r.reading}
                      {r.unit ? ` ${r.unit}` : ''}
                    </span>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                  <span>{TEST_RECORD_KIND_LABELS[r.kind]}</span>
                  {r.note ? <span className="truncate">· {r.note}</span> : null}
                  <time dateTime={new Date(r.performedAt).toISOString()}>· {fmt.date(r.performedAt)}</time>
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => removeRecord.mutate({ recordId: r.id, itemId: item.id })}
                disabled={removeRecord.isPending}
                aria-label={`Remove test record — ${r.name}`}
                data-testid="remove-test-record"
              >
                <DeleteIcon className="text-glyph-danger" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <LiveRegion visuallyHidden>
        {record.isSuccess ? <p>Test record added.</p> : null}
        {removeRecord.isSuccess ? <p>Test record removed.</p> : null}
      </LiveRegion>
    </section>
  );
}

/**
 * Compact labelled-field wrapper matching {@link RevaluationEditor}'s `RField` — a `text-xs` label
 * above its control at the compact field gap, with an optional top-right {@link InfoHint} and a
 * `role="alert"` error line.
 */
function TField({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="relative">
      <label className="block">
        <span className={cn('mb-field-gap-compact block text-xs text-muted-foreground', hint && 'pr-5')}>
          {label}
        </span>
        {children}
      </label>
      {hint ? (
        <span className="absolute right-0 top-0">
          <InfoHint content={hint} />
        </span>
      ) : null}
      {error ? (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
