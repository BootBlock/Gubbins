import { Input, Select, Tooltip } from '@/components/foundry';
import { CloseIcon } from '@/components/icons';
import type { FilterCondition, FilterOperator } from '@/db/search/ast';
import { useSearchBuilder } from '../SearchBuilderContext';
import type { BuilderPath } from '../builder-reducer';
import {
  BUILDER_FIELDS,
  operatorLabelFor,
  capabilityKey,
  customFieldName,
  fieldSelectValue,
  isCapabilityField,
  isCustomField,
  kindOfField,
  operatorsForKind,
  toCapabilityField,
  toCustomField,
} from '../fields';

/**
 * A single leaf-condition row in the Visual Builder (spec §5.1): field · (capability
 * key) · operator · value. All edits dispatch immutable `updateCondition` actions
 * against the Tier-3 AST; nothing here writes SQL.
 */
export function ConditionEditor({
  condition,
  path,
}: {
  condition: FilterCondition;
  path: BuilderPath;
}) {
  const { dispatch } = useSearchBuilder();
  const isCapability = isCapabilityField(condition.field);
  const isCustom = isCustomField(condition.field);
  const kind = kindOfField(condition.field);
  const operators = operatorsForKind(kind);
  const showValue = condition.operator !== 'HAS_CAPABILITY';
  const numericValue =
    kind === 'number' ||
    ((isCapability || isCustom) &&
      (condition.operator === 'GREATER_THAN' || condition.operator === 'LESS_THAN'));

  const onFieldChange = (next: string) => {
    if (next === 'capability') {
      dispatch({
        type: 'updateCondition',
        path,
        patch: { field: 'capability:', operator: 'HAS_CAPABILITY', value: true },
      });
      return;
    }
    if (next === 'customfield') {
      dispatch({
        type: 'updateCondition',
        path,
        patch: { field: 'field:', operator: 'CONTAINS', value: '' },
      });
      return;
    }
    const op = operatorsForKind(kindOfField(next))[0];
    dispatch({ type: 'updateCondition', path, patch: { field: next, operator: op, value: '' } });
  };

  const onOperatorChange = (op: FilterOperator) => {
    const patch: Partial<FilterCondition> =
      op === 'HAS_CAPABILITY'
        ? { operator: op, value: true }
        : typeof condition.value === 'boolean'
          ? { operator: op, value: '' }
          : { operator: op };
    dispatch({ type: 'updateCondition', path, patch });
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        aria-label="Field"
        value={fieldSelectValue(condition.field)}
        onChange={(e) => onFieldChange(e.target.value)}
        className="h-9 w-36"
      >
        {BUILDER_FIELDS.map((f) => (
          <option key={f.value} value={f.value}>
            {f.label}
          </option>
        ))}
      </Select>

      {isCapability ? (
        <Tooltip
          content="The capability **key** to match, e.g. `voltage` or `tolerance` — the name of the spec, not its value."
          triggerTabIndex={-1}
        >
          <Input
            aria-label="Capability key"
            placeholder="voltage"
            value={capabilityKey(condition.field)}
            onChange={(e) =>
              dispatch({
                type: 'updateCondition',
                path,
                patch: { field: toCapabilityField(e.target.value) },
              })
            }
            className="h-9 w-28"
          />
        </Tooltip>
      ) : null}

      {isCustom ? (
        <Tooltip
          content="The custom-field **name** to match, e.g. `Datasheet` or `Voltage rating` — exactly as defined on the category. Unknown names simply match nothing."
          triggerTabIndex={-1}
        >
          <Input
            aria-label="Custom field name"
            placeholder="Datasheet"
            value={customFieldName(condition.field)}
            onChange={(e) =>
              dispatch({
                type: 'updateCondition',
                path,
                patch: { field: toCustomField(e.target.value) },
              })
            }
            className="h-9 w-32"
          />
        </Tooltip>
      ) : null}

      <Select
        aria-label="Operator"
        value={condition.operator}
        onChange={(e) => onOperatorChange(e.target.value as FilterOperator)}
        className="h-9 w-40"
      >
        {operators.map((op) => (
          <option key={op} value={op}>
            {operatorLabelFor(op, kind)}
          </option>
        ))}
      </Select>

      {showValue ? (
        <Input
          aria-label="Value"
          value={typeof condition.value === 'boolean' ? '' : String(condition.value)}
          inputMode={numericValue ? 'decimal' : 'text'}
          onChange={(e) => dispatch({ type: 'updateCondition', path, patch: { value: e.target.value } })}
          placeholder={numericValue ? '0' : 'value…'}
          className="h-9 w-32"
        />
      ) : null}

      <Tooltip content="Remove this condition from the group." triggerTabIndex={-1} className="ml-auto">
        <span>
          <button
            type="button"
            aria-label="Remove condition"
            onClick={() => dispatch({ type: 'remove', path })}
            className="grid size-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive [&_svg]:size-4"
          >
            <CloseIcon />
          </button>
        </span>
      </Tooltip>
    </div>
  );
}
