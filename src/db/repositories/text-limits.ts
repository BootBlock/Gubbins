/**
 * The repository-side half of the text length limits (issue #346).
 *
 * `lib/text-limits.ts` says how long each shape of text may be and is dependency-free, so that
 * the controls on screen, the import readers and the schema can all read the same numbers. This
 * is where a write path turns one of those numbers into a refusal.
 *
 * It exists so the refusal is a **sentence**. Every user-editable column carries a length CHECK
 * as its last line, but a CHECK reports itself as `CHECK constraint failed: <table>`, which
 * names neither the field nor the ceiling and reaches the user as the generic database wording
 * (see `features/errors/db-error-message.ts`). Checking here first means the save that fails
 * says which field is too long and by how much — and it means the *import* path, which has no
 * control on screen to have flagged it earlier, fails the one row rather than the whole file.
 */
import { exceedsTextLimit, textLength } from '@/lib/text-limits';
import { DbError } from '../errors';

/**
 * Refuse `value` if it is longer than `limit` code points.
 *
 * `subject` is the field as a user would name it, and it starts the sentence — "An item name
 * can be at most 500 characters, and this one is 51,204." Thrown under `SQLITE_CONSTRAINT`
 * because that is what it is: the application stating the constraint the column would have
 * stated less helpfully a moment later.
 */
export function assertTextLimit(value: string, limit: number, subject: string): void {
  if (!exceedsTextLimit(value, limit)) return;
  throw new DbError(
    'SQLITE_CONSTRAINT',
    `${subject} can be at most ${limit} characters, and this one is ${textLength(value)}.`,
  );
}
