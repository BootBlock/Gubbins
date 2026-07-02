// Prettier config. Values chosen to match the code already in the tree so adopting the
// formatter reflows as little as possible — the repo already sits at single-quote, semi,
// 2-space, and ~110-col lines (p99 = 108). Prettier never adds/removes braces, so the
// braceless-if house style is enforced by ESLint's `curly` rule, not here.
/** @type {import('prettier').Config} */
export default {
  semi: true,
  singleQuote: true,
  trailingComma: 'all',
  printWidth: 110,
  tabWidth: 2,
  arrowParens: 'always',
};
