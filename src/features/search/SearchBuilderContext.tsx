/**
 * Tier-3 ephemeral state for the Visual Builder (spec §2.1, §5.1).
 *
 * The abstract syntax tree of the search is highly ephemeral, so per §2.1 it lives
 * in this Context — mounted and unmounted with the inventory workspace — rather
 * than in a global store, preventing it from leaking when the user navigates away.
 * The reducer ({@link builderReducer}) is pure and unit-tested separately.
 */
import { createContext, useContext, useMemo, useReducer, type ReactNode } from 'react';
import { emptyAst, type ASTGroupNode } from '@/db/search/ast';
import { builderReducer, countConditions, type BuilderAction } from './builder-reducer';

interface SearchBuilderValue {
  readonly ast: ASTGroupNode;
  readonly dispatch: (action: BuilderAction) => void;
  /** Number of leaf conditions — zero means "no active query" (list everything). */
  readonly conditionCount: number;
}

const SearchBuilderContext = createContext<SearchBuilderValue | null>(null);

export function SearchBuilderProvider({ children }: { children: ReactNode }) {
  const [ast, dispatch] = useReducer(builderReducer, undefined, () => emptyAst('AND'));
  const value = useMemo<SearchBuilderValue>(
    () => ({ ast, dispatch, conditionCount: countConditions(ast) }),
    [ast],
  );
  return <SearchBuilderContext.Provider value={value}>{children}</SearchBuilderContext.Provider>;
}

export function useSearchBuilder(): SearchBuilderValue {
  const value = useContext(SearchBuilderContext);
  if (!value) {
    throw new Error('useSearchBuilder must be used within a SearchBuilderProvider.');
  }
  return value;
}
