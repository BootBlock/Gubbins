import { Button, Tooltip } from '@/components/foundry';
import { AddGroupIcon, AddIcon, CloseIcon } from '@/components/icons';
import { isGroupNode, type ASTGroupNode, type LogicalOperator } from '@/db/search/ast';
import { useSearchBuilder } from '../SearchBuilderContext';
import { canAddGroup, type BuilderPath } from '../builder-reducer';
import { ConditionEditor } from './ConditionEditor';

/**
 * A recursive group node in the Visual Builder (spec §5.1): an AND/OR toggle over a
 * list of conditions and nested groups. Nesting is capped at the §5.1 depth limit —
 * the "Add group" button disables once the cap is reached.
 */
export function GroupEditor({
  group,
  path,
  depth,
}: {
  group: ASTGroupNode;
  path: BuilderPath;
  depth: number;
}) {
  const { dispatch } = useSearchBuilder();
  const isRoot = path.length === 0;

  return (
    <div
      className={
        isRoot
          ? 'space-y-3'
          : 'space-y-3 rounded-xl border border-border/70 border-l-2 border-l-primary/40 bg-secondary/30 p-3'
      }
    >
      <div className="flex items-center gap-2">
        <OperatorToggle
          value={group.logicalOperator}
          onChange={(operator) => dispatch({ type: 'setOperator', path, operator })}
        />
        <span className="text-xs text-muted-foreground">
          {group.logicalOperator === 'AND' ? 'match all of' : 'match any of'}
        </span>
        {!isRoot ? (
          <Tooltip
            content="Remove this nested group and all the conditions inside it."
            triggerTabIndex={-1}
            className="ml-auto"
          >
            <span>
              <button
                type="button"
                aria-label="Remove group"
                onClick={() => dispatch({ type: 'remove', path })}
                className="grid size-7 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive [&_svg]:size-3.5"
              >
                <CloseIcon />
              </button>
            </span>
          </Tooltip>
        ) : null}
      </div>

      {group.conditions.length === 0 ? (
        <p className="text-xs text-muted-foreground">No conditions yet — add one below.</p>
      ) : (
        <div className="space-y-2">
          {group.conditions.map((child, index) => {
            const childPath = [...path, index];
            return isGroupNode(child) ? (
              <GroupEditor key={`g-${index}`} group={child} path={childPath} depth={depth + 1} />
            ) : (
              <div key={`c-${index}`} className="rounded-lg border border-border/60 bg-card/50 p-2">
                <ConditionEditor condition={child} path={childPath} />
              </div>
            );
          })}
        </div>
      )}

      <div className="flex gap-2">
        <Tooltip
          content="Add a filter condition (field, operator, value) to this group."
          triggerTabIndex={-1}
        >
          <span>
            <Button
              type="button"
              variant="outline"
              onClick={() => dispatch({ type: 'addCondition', path })}
              className="h-8 text-xs"
            >
              <AddIcon />
              Add condition
            </Button>
          </span>
        </Tooltip>
        <Tooltip
          content="Add a nested sub-group so you can mix **AND** and **OR** logic — e.g. *this* and (*that* or *the other*)."
          triggerTabIndex={-1}
        >
          <span>
            <Button
              type="button"
              variant="ghost"
              disabled={!canAddGroup(path)}
              onClick={() => dispatch({ type: 'addGroup', path })}
              className="h-8 text-xs"
            >
              <AddGroupIcon />
              Add group
            </Button>
          </span>
        </Tooltip>
      </div>
    </div>
  );
}

/** A small segmented AND/OR switch. */
function OperatorToggle({
  value,
  onChange,
}: {
  value: LogicalOperator;
  onChange: (value: LogicalOperator) => void;
}) {
  return (
    <Tooltip
      content="**AND** keeps items matching *every* condition in this group; **OR** keeps items matching *any* one of them."
      triggerTabIndex={-1}
    >
      <div
        role="radiogroup"
        aria-label="Group operator"
        className="inline-flex rounded-lg bg-secondary p-0.5"
      >
        {(['AND', 'OR'] as const).map((op) => (
          <button
            key={op}
            type="button"
            role="radio"
            aria-checked={value === op}
            onClick={() => onChange(op)}
            className={
              value === op
                ? 'rounded-md bg-primary px-2.5 py-1 text-xs font-semibold text-primary-foreground'
                : 'rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground'
            }
          >
            {op}
          </button>
        ))}
      </div>
    </Tooltip>
  );
}
