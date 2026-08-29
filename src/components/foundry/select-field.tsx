import { useId, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { fieldAria } from './field-aria';
import { InfoHint } from './info-hint';
import { Select, type SelectOption } from './select';
import { type TooltipSize } from './tooltip';

export interface SelectFieldProps {
  readonly label: ReactNode;
  readonly options: readonly SelectOption[];
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Validation message; when present the control is marked invalid and this is announced. */
  readonly error?: string;
  /** Optional rich-Markdown help, surfaced via an {@link InfoHint} `i` badge (like {@link FormField}). */
  readonly hint?: string;
  /** Widen the hint bubble for richer help (tables, code, longer docs). Defaults to `sm`. */
  readonly hintSize?: TooltipSize;
  readonly className?: string;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly id?: string;
  readonly 'data-testid'?: string;
}

/**
 * A labelled {@link Select} — the combobox counterpart to {@link FormField}. Because a
 * `role="combobox"` element is not a labelable form control, an implicit `<label>` can't
 * name it; instead the label is a `<span>` with an id and the combobox references it via
 * `aria-labelledby` (the same idiom the location picker uses). Validation errors are
 * wired for assistive tech exactly as FormField does, via the pure {@link fieldAria} seam.
 */
export function SelectField({
  label,
  options,
  value,
  onChange,
  error,
  hint,
  hintSize,
  className,
  placeholder,
  disabled,
  id,
  'data-testid': testId,
}: SelectFieldProps) {
  const reactId = useId();
  const baseId = id ?? reactId;
  const labelId = `${baseId}-label`;
  const { controlProps, errorId, hasError } = fieldAria(baseId, error);
  return (
    <div className={cn('relative', className)}>
      <span id={labelId} className={cn('mb-field-gap block text-sm font-medium', hint && 'pr-6')}>
        {label}
      </span>
      <Select
        id={baseId}
        value={value}
        onChange={onChange}
        options={options}
        placeholder={placeholder}
        disabled={disabled}
        aria-labelledby={labelId}
        aria-invalid={controlProps['aria-invalid']}
        aria-describedby={controlProps['aria-describedby']}
        data-testid={testId}
      />
      {hint ? (
        <span className="absolute right-0 top-0.5">
          <InfoHint content={hint} size={hintSize} />
        </span>
      ) : null}
      {hasError ? (
        <span id={errorId} role="alert" className="mt-1 block text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </div>
  );
}
