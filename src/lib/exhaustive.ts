/**
 * The app-wide exhaustiveness guard for a `switch` over a domain string-union (issue #355).
 *
 * `noFallthroughCasesInSwitch` catches a *fallthrough* but never a **missing** case, so a
 * switch that ends in a bare `default:` keeps compiling when a variant is added to its SSOT
 * — the new variant silently takes the fallback branch. That is exactly how a new `FieldType`
 * used to reach {@link import('@/features/inventory/components/TypedFieldControl').TypedFieldControl}
 * as a plain text box while `validateFieldValue` (which *does* guard) demanded attention.
 *
 * Call this from the `default:` branch and the switch stops compiling the moment a variant is
 * added without a case: TypeScript narrows `value` to `never` only when every member is
 * handled, so an unhandled one fails to be assignable to the `never` parameter.
 *
 * ## When a switch needs the guard
 *
 * A switch is already protected *only* when it is the body of a function whose declared return
 * type **excludes `undefined`**. A missing case then makes the end point of the function
 * reachable, and `strictNullChecks` fires TS2366 ("function lacks ending return statement").
 *
 * "Has an explicit return type" is **not** the test — the return type has to exclude
 * `undefined`, and three common shapes do not (issue #562):
 *
 * - **A React component**, which is written without a return-type annotation at all. An
 *   unhandled variant just renders nothing.
 * - **A `: ReactNode` return**, which *includes* `undefined`, so the annotation looks
 *   protective and is not. TS2366 never fires.
 * - **A `: void` handler** — an event handler that acts on a union rather than returning a
 *   value. An unhandled member is silently ignored, and where the handler has already called
 *   `preventDefault()` the key is swallowed rather than reaching the browser.
 *
 * Each of those needs the explicit call. Guarding the *pure seam* over a union without
 * guarding the component or handler that consumes it only inverts the asymmetry, so when
 * adding a guard, find every switch over that union first.
 */

/**
 * Assert that `value` has been narrowed to `never` — i.e. the switch above handled every
 * member of the union. **Compile-time only:** it deliberately does nothing at runtime and
 * never throws, so the call site keeps whatever graceful fallback it already had for a value
 * that arrives out of band (a stale row, an older/newer build's persisted preference, an
 * imported string). Follow the call with that fallback:
 *
 * ```ts
 * switch (field.fieldType) {
 *   case 'TEXT':
 *     return renderText();
 *   // …every other variant…
 *   default:
 *     assertExhaustive(field.fieldType);
 *     return renderText(); // out-of-band value: degrade, don't crash
 * }
 * ```
 *
 * Where reaching the branch is genuinely a programming error rather than untrusted data, throw
 * instead — see `assertNever` in `src/db/worker/database.worker.ts`, which raises a typed
 * `DbError` because an unknown RPC request has no sane fallback.
 */
export function assertExhaustive(_value: never): void {
  // Intentionally empty — the type of the parameter *is* the check.
}
