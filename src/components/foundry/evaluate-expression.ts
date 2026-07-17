/**
 * Micro-calculator engine (issue #93) — the pure seam behind {@link NumberInput}.
 *
 * A number field is far more useful if you can *do sums in it*: type `500/2` and it
 * settles to `250`, `12*3` to `36`, `(2+3)*4` to `20`. This module is the safe, tiny
 * arithmetic evaluator that powers that, with **no `eval`/`Function`** anywhere — a
 * hand-rolled tokeniser + recursive-descent parser over a deliberately small grammar,
 * so a value box can never become a script-injection surface.
 *
 * Supported: `+ − × ÷` (ASCII `+ - * /` and the Unicode `− × ÷` glyphs), `^` power
 * (right-associative), a postfix `%` meaning "divide by 100" (`50%` → `0.5`,
 * `200*50%` → `100`), parentheses, unary `+`/`-`, decimals (`.5`, `5.`), and
 * whitespace. Anything else — a stray letter, a dangling operator, a division by zero,
 * a result that isn't finite — fails cleanly as `{ ok: false }`, and the caller leaves
 * the field untouched rather than clobbering it.
 *
 * Grammar (lowest to highest precedence):
 *   expr    := term   (('+' | '-') term)*
 *   term    := factor (('*' | '/') factor)*
 *   factor  := unary  ('^' factor)?            // right-associative power
 *   unary   := ('+' | '-') unary | postfix
 *   postfix := primary ('%')*
 *   primary := number | '(' expr ')'
 */

/** The result of {@link evaluateExpression}: a finite number, or a clean failure. */
export type EvalResult = { readonly ok: true; readonly value: number } | { readonly ok: false };

/** Characters that make a string a *calculation* rather than a plain typed number. */
const OPERATOR_CHARS = '+-*/^%×÷−()';

/**
 * Does this text look like a calculation the user expects to be worked out, rather than
 * a value they typed directly? True when it holds an arithmetic operator or parenthesis
 * beyond a single leading sign — i.e. it is *not* a bare numeric literal like `-12.5`.
 * Used to decide whether to show the live result preview and whether to rewrite on
 * commit, so a plainly-typed number is never needlessly reformatted.
 */
export function hasCalcExpression(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === '') return false;
  // A bare number (optionally signed) is not a calculation.
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(trimmed)) return false;
  // Otherwise, treat it as a calculation only if it actually contains an operator glyph
  // (so free text like "abc" isn't mistaken for a — failing — expression to preview).
  for (const ch of trimmed) if (OPERATOR_CHARS.includes(ch)) return true;
  return false;
}

type Tok = 'num' | '+' | '-' | '*' | '/' | '^' | '%' | '(' | ')';

interface Token {
  readonly type: Tok;
  /** Numeric value, present only for a `'num'` token. */
  readonly value?: number;
}

/** Fold the Unicode operator glyphs onto their ASCII equivalents before tokenising. */
function normalise(input: string): string {
  return input
    .replace(/×/g, '*') // × multiplication sign
    .replace(/[÷]/g, '/') // ÷ division sign
    .replace(/[−‒–—]/g, '-'); // −, figure/en/em dashes → hyphen-minus
}

/** Split the expression into tokens, or `null` on an unrecognised character. */
function tokenise(input: string): Token[] | null {
  const src = normalise(input);
  // `noUncheckedIndexedAccess` types `src[k]` as `string | undefined`; read through a helper
  // that yields '' past the end, so the digit/whitespace comparisons stay simple and safe.
  const at = (k: number): string => src[k] ?? '';
  const isDigit = (c: string): boolean => c >= '0' && c <= '9';
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = at(i);
    if (ch === ' ' || ch === '\t') {
      i++;
      continue;
    }
    if (isDigit(ch)) {
      let j = i;
      while (isDigit(at(j))) j++;
      if (at(j) === '.') {
        j++;
        while (isDigit(at(j))) j++;
      }
      tokens.push({ type: 'num', value: Number(src.slice(i, j)) });
      i = j;
      continue;
    }
    if (ch === '.') {
      let j = i + 1;
      while (isDigit(at(j))) j++;
      if (j === i + 1) return null; // a lone '.' is not a number
      tokens.push({ type: 'num', value: Number(src.slice(i, j)) });
      i = j;
      continue;
    }
    switch (ch) {
      case '+':
        tokens.push({ type: '+' });
        break;
      case '-':
        tokens.push({ type: '-' });
        break;
      case '*':
        tokens.push({ type: '*' });
        break;
      case '/':
        tokens.push({ type: '/' });
        break;
      case '^':
        tokens.push({ type: '^' });
        break;
      case '%':
        tokens.push({ type: '%' });
        break;
      case '(':
        tokens.push({ type: '(' });
        break;
      case ')':
        tokens.push({ type: ')' });
        break;
      default:
        return null; // unrecognised character — not an expression we can evaluate
    }
    i++;
  }
  return tokens;
}

/**
 * Recursive-descent parser over the token stream. Throws on any malformed input; the
 * public {@link evaluateExpression} catches that and reports a clean failure.
 */
class Parser {
  private pos = 0;
  constructor(private readonly tokens: readonly Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private eat(type: Tok): void {
    if (this.peek()?.type !== type) throw new Error('unexpected token');
    this.pos++;
  }

  parse(): number {
    if (this.tokens.length === 0) throw new Error('empty');
    const value = this.expr();
    if (this.pos !== this.tokens.length) throw new Error('trailing input');
    return value;
  }

  private expr(): number {
    let left = this.term();
    for (let t = this.peek(); t?.type === '+' || t?.type === '-'; t = this.peek()) {
      this.pos++;
      const right = this.term();
      left = t.type === '+' ? left + right : left - right;
    }
    return left;
  }

  private term(): number {
    let left = this.factor();
    for (let t = this.peek(); t?.type === '*' || t?.type === '/'; t = this.peek()) {
      this.pos++;
      const right = this.factor();
      left = t.type === '*' ? left * right : left / right;
    }
    return left;
  }

  private factor(): number {
    const base = this.unary();
    // Right-associative power: `2^3^2` = `2^(3^2)`.
    if (this.peek()?.type === '^') {
      this.pos++;
      return base ** this.factor();
    }
    return base;
  }

  private unary(): number {
    const t = this.peek();
    if (t?.type === '+') {
      this.pos++;
      return this.unary();
    }
    if (t?.type === '-') {
      this.pos++;
      return -this.unary();
    }
    return this.postfix();
  }

  private postfix(): number {
    let value = this.primary();
    while (this.peek()?.type === '%') {
      this.pos++;
      value /= 100;
    }
    return value;
  }

  private primary(): number {
    const t = this.peek();
    if (t?.type === 'num') {
      this.pos++;
      return t.value!;
    }
    if (t?.type === '(') {
      this.pos++;
      const value = this.expr();
      this.eat(')');
      return value;
    }
    throw new Error('expected a number or (');
  }
}

/**
 * Safely evaluate an arithmetic expression, returning a **finite** number or a clean
 * failure. Never throws, never uses `eval`. Division by zero, overflow to `Infinity`,
 * and `NaN` all report `{ ok: false }` so the caller can leave the field as-is.
 */
export function evaluateExpression(input: string): EvalResult {
  const tokens = tokenise(input);
  if (tokens === null) return { ok: false };
  try {
    const value = new Parser(tokens).parse();
    if (!Number.isFinite(value)) return { ok: false };
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

/**
 * Render an evaluated result back into the field as a plain, parseable numeric string
 * (no locale grouping — the value must round-trip through `Number()` for validation).
 * Binary floating-point noise (`0.1 + 0.2` → `0.30000000000000004`) is trimmed by
 * rounding to 12 significant digits, which is well within double precision yet hides
 * the artefacts of exact decimals people actually type.
 */
export function formatCalcResult(value: number): string {
  // `toPrecision` can emit exponential form for very large/small magnitudes; `Number(...)`
  // normalises `12.000` → `12` and keeps ordinary magnitudes in plain decimal.
  return String(Number(value.toPrecision(12)));
}
