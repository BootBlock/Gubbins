import { Surface } from '@/components/foundry';
import { FilterIcon } from '@/components/icons';
import { useSearchBuilder } from '../SearchBuilderContext';
import { astError } from '../queries';
import { GroupEditor } from './GroupEditor';

/**
 * The Visual Builder panel (spec §5.1, §3) — a purely graphical query builder over
 * the Tier-3 AST. It renders the root group recursively and surfaces any
 * translation error inline (so an in-progress invalid edit never reaches the
 * worker). The results it drives are rendered by the inventory workspace.
 */
export function VisualBuilder({ resultSummary }: { resultSummary?: string }) {
  const { ast, dispatch, conditionCount } = useSearchBuilder();
  const error = conditionCount > 0 ? astError(ast) : null;

  return (
    <Surface className="space-y-3 p-4">
      <div className="flex items-center gap-2">
        <span className="grid size-7 place-items-center rounded-lg bg-primary/15 text-primary [&_svg]:size-4">
          <FilterIcon />
        </span>
        <h2 className="text-sm font-semibold">Visual search</h2>
        {resultSummary ? (
          <span className="text-xs text-muted-foreground">· {resultSummary}</span>
        ) : null}
        {conditionCount > 0 ? (
          <button
            type="button"
            onClick={() => dispatch({ type: 'reset' })}
            className="ml-auto text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
          >
            Clear
          </button>
        ) : null}
      </div>

      <GroupEditor group={ast} path={[]} depth={1} />

      {error ? (
        <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>
      ) : null}
    </Surface>
  );
}
