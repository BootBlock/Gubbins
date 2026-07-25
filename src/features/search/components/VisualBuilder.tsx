import { CloseButton, Surface } from '@/components/foundry';
import { FilterIcon } from '@/components/icons';
import { useSearchBuilder } from '../SearchBuilderContext';
import { astError } from '../queries';
import { GroupEditor } from './GroupEditor';
import { NaturalLanguageInput } from './NaturalLanguageInput';
import { TextQueryInput } from './TextQueryInput';

/**
 * The Visual Builder panel (spec §5.1, §3) — a purely graphical query builder over
 * the Tier-3 AST. It renders the root group recursively and surfaces any
 * translation error inline (so an in-progress invalid edit never reaches the
 * worker). The results it drives are rendered by the inventory workspace.
 *
 * `onClose` dismisses the panel from its top-right ✕ — the same Foundry {@link CloseButton}
 * the dialog headers use, so closing the card matches closing any dialog.
 */
export function VisualBuilder({ resultSummary, onClose }: { resultSummary?: string; onClose: () => void }) {
  const { ast, dispatch, conditionCount } = useSearchBuilder();
  const error = conditionCount > 0 ? astError(ast) : null;

  return (
    // The panel is a named scope, not just a look: its saved-search controls are now mirrored
    // on the Inventory quick-search box (issue #136), so both mount points render the same
    // testids. Anything driving *this* copy has to say which one it means.
    <Surface className="space-y-3 p-4" data-testid="visual-builder">
      <div className="flex items-center gap-2">
        <span className="grid size-7 place-items-center rounded-lg bg-primary/15 text-primary [&_svg]:size-4">
          <FilterIcon />
        </span>
        <h2 className="text-sm font-semibold">Visual search</h2>
        {resultSummary ? <span className="text-xs text-muted-foreground">· {resultSummary}</span> : null}
        <div className="ml-auto flex items-center gap-1">
          {conditionCount > 0 ? (
            <button
              type="button"
              onClick={() => dispatch({ type: 'reset' })}
              className="text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
            >
              Clear
            </button>
          ) : null}
          <CloseButton onClick={onClose} label="Close visual search" />
        </div>
      </div>

      <NaturalLanguageInput />

      <div className="h-px bg-border/60" role="separator" />

      <TextQueryInput />

      <div className="h-px bg-border/60" role="separator" />

      <GroupEditor group={ast} path={[]} depth={1} />

      {error ? (
        <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>
      ) : null}
    </Surface>
  );
}
