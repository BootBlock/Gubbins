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
