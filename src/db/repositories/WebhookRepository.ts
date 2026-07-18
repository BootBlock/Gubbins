/**
 * WebhookRepository (issue #87 — user-configured "call this URL when this happens").
 *
 * The app *configures* subscriptions; the **bridge** delivers them, reading this table out of
 * the database it already hydrates. Nothing here calls the network, and nothing here derives an
 * event — this is CRUD over configuration, and deliberately no more.
 *
 * An independent synced LWW leaf with a random-UUID primary key, like `wishlist` /
 * `tare_presets`. All the validation and normalisation lives in the pure
 * `@/features/webhooks/subscription` seam; this is the thin SQL glue around it, plus the
 * JSON (de)serialisation of the three opaque TEXT columns so callers exchange typed values —
 * an array of event types, a filter object, a header map — and never a raw JSON string.
 *
 * Creates/updates grow storage and are therefore Hard-Stop gated; deletes (which free space)
 * are not, and record a tombstone so the deletion propagates on the next sync (§7.2).
 */
import { DbError } from '../errors';
import { BaseRepository } from './base';
import { rowToWebhookSubscription } from './mappers';
import { tombstoneStatement } from './tombstone';
import {
  normaliseWebhookEventTypes,
  normaliseWebhookHeaders,
  normaliseWebhookMethod,
  normaliseWebhookName,
  normaliseWebhookText,
  planWebhookSubscription,
  sanitiseWebhookUrl,
  type WebhookPlanError,
} from '@/features/webhooks/subscription';
import type {
  CreateWebhookInput,
  Page,
  PageParams,
  UpdateWebhookInput,
  WebhookRow,
  WebhookSubscription,
} from './types';

/** User-facing message for each reason `planWebhookSubscription` can reject a subscription. */
const REJECTION_MESSAGE: Record<WebhookPlanError, string> = {
  EMPTY_NAME: 'A webhook must have a name.',
  INVALID_URL: 'Enter a full web address starting with http:// or https://.',
  NO_EVENT_TYPES: 'Choose at least one event for this webhook to send.',
  SECRET_CONFLICT: 'A webhook signs with either its own secret or a bridge-side secret name, not both.',
  INVALID_HEADERS: 'Every extra header needs a name and a text value.',
};

export class WebhookRepository extends BaseRepository {
  async getById(id: string): Promise<WebhookSubscription | undefined> {
    const row = await this.driver.queryOne<WebhookRow>('SELECT * FROM webhooks WHERE id = ?;', [id]);
    return row ? rowToWebhookSubscription(row) : undefined;
  }

  /**
   * Paginated subscriptions, ordered for display: by name (case-insensitive), then oldest-first,
   * then id — a stable total order, so a page is already correctly ordered and two subscriptions
   * sharing a name never swap places between reads.
   *
   * Disabled subscriptions are listed alongside enabled ones: this is the management view, and
   * hiding a subscription the user switched off is how it gets forgotten about. Selecting the
   * *deliverable* set is the bridge's business, not this list's.
   */
  async list(params: PageParams = {}): Promise<Page<WebhookSubscription>> {
    const { limit, offset } = this.resolvePage(params);
    const rows = await this.driver.query<WebhookRow>(
      `SELECT * FROM webhooks
       ORDER BY name COLLATE NOCASE ASC, created_at ASC, id ASC
       LIMIT ? OFFSET ?;`,
      [limit, offset],
    );
    return this.toPage(rows.map(rowToWebhookSubscription), limit, offset);
  }

  /**
   * Create a subscription. Everything is validated + normalised by the pure
   * `planWebhookSubscription` seam (a blank name, a non-`http(s)` endpoint, no event types, both
   * secret forms at once, or a malformed header map is rejected with a clear message); an
   * unknown method softens to `POST`. Write-gated (it grows storage).
   */
  async create(input: CreateWebhookInput): Promise<WebhookSubscription> {
    this.assertWritable();
    const plan = planWebhookSubscription(input);
    if (!plan.ok) {
      throw new DbError('SQLITE_CONSTRAINT', REJECTION_MESSAGE[plan.reason]);
    }
    const id = crypto.randomUUID();
    const { name, url, method, enabled, secret, secretRef, eventTypes, filter, template, headers } =
      plan.subscription;
    await this.driver.execute(
      `INSERT INTO webhooks
         (id, name, url, method, enabled, secret, secret_ref, event_types, filter, template, headers)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        id,
        name,
        url,
        method,
        enabled ? 1 : 0,
        secret,
        secretRef,
        JSON.stringify(eventTypes),
        filter === null ? null : JSON.stringify(filter),
        template,
        headers === null ? null : JSON.stringify(headers),
      ],
    );
    return (await this.getById(id))!;
  }

  /**
   * Update selected fields — only the provided fields change, and each is run through the same
   * seam normalisers `create` uses (so the same invariants hold): the name/URL cannot be cleared
   * or made invalid, the event-type list cannot be emptied, and an unknown method softens to
   * `POST`. Write-gated (an edit can grow storage). Returns the updated subscription.
   *
   * The two secret columns are resolved against the row's **current** state, not just the patch:
   * setting `secret` on a subscription that already carries a `secretRef` (or vice versa) is
   * refused rather than silently producing a row the DB CHECK would reject. Clearing one and
   * setting the other in a single update is the supported way to switch between them.
   */
  async update(id: string, input: UpdateWebhookInput): Promise<WebhookSubscription> {
    this.assertWritable();
    const existing = await this.require(id);

    const sets: string[] = [];
    const params: (string | number | null)[] = [];

    if (input.name !== undefined) {
      const name = normaliseWebhookName(input.name);
      if (name === null) throw new DbError('SQLITE_CONSTRAINT', REJECTION_MESSAGE.EMPTY_NAME);
      sets.push('name = ?');
      params.push(name);
    }
    if (input.url !== undefined) {
      const url = sanitiseWebhookUrl(input.url);
      if (url === undefined) throw new DbError('SQLITE_CONSTRAINT', REJECTION_MESSAGE.INVALID_URL);
      sets.push('url = ?');
      params.push(url);
    }
    if (input.method !== undefined) {
      sets.push('method = ?');
      params.push(normaliseWebhookMethod(input.method));
    }
    if (input.enabled !== undefined) {
      sets.push('enabled = ?');
      params.push(input.enabled ? 1 : 0);
    }
    if (input.eventTypes !== undefined) {
      const eventTypes = normaliseWebhookEventTypes(input.eventTypes);
      if (eventTypes === undefined) {
        throw new DbError('SQLITE_CONSTRAINT', REJECTION_MESSAGE.NO_EVENT_TYPES);
      }
      sets.push('event_types = ?');
      params.push(JSON.stringify(eventTypes));
    }

    // Resolve both secret columns together against the row's post-update state, so the
    // "at most one" invariant is checked once on the real outcome rather than per-field.
    if (input.secret !== undefined || input.secretRef !== undefined) {
      const secret = input.secret !== undefined ? normaliseWebhookText(input.secret) : existing.secret;
      const secretRef =
        input.secretRef !== undefined ? normaliseWebhookText(input.secretRef) : existing.secretRef;
      if (secret !== null && secretRef !== null) {
        throw new DbError('SQLITE_CONSTRAINT', REJECTION_MESSAGE.SECRET_CONFLICT);
      }
      sets.push('secret = ?', 'secret_ref = ?');
      params.push(secret, secretRef);
    }

    if (input.filter !== undefined) {
      sets.push('filter = ?');
      params.push(input.filter === null ? null : JSON.stringify(input.filter));
    }
    if (input.template !== undefined) {
      sets.push('template = ?');
      params.push(normaliseWebhookText(input.template));
    }
    if (input.headers !== undefined) {
      const headers = normaliseWebhookHeaders(input.headers);
      if (headers === undefined) {
        throw new DbError('SQLITE_CONSTRAINT', REJECTION_MESSAGE.INVALID_HEADERS);
      }
      sets.push('headers = ?');
      params.push(headers === null ? null : JSON.stringify(headers));
    }

    if (sets.length > 0) {
      await this.driver.execute(`UPDATE webhooks SET ${sets.join(', ')} WHERE id = ?;`, [...params, id]);
    }
    return (await this.getById(id))!;
  }

  /**
   * Delete a subscription — DELETE + tombstone in the same transaction so the removal propagates
   * on the next sync (§7.2), which is also how the bridge learns to stop delivering to it.
   * Always permitted (a delete frees storage). A no-op when the id is absent: no tombstone is
   * recorded (tombstoning an id this device never held would wrongly instruct peers to delete it).
   */
  async delete(id: string): Promise<void> {
    if (!(await this.getById(id))) return;
    await this.driver.transaction([
      { sql: 'DELETE FROM webhooks WHERE id = ?;', params: [id] },
      tombstoneStatement('webhooks', id),
    ]);
  }

  private async require(id: string): Promise<WebhookSubscription> {
    const subscription = await this.getById(id);
    if (!subscription) {
      throw new DbError('SQLITE_CONSTRAINT', `Webhook "${id}" does not exist.`);
    }
    return subscription;
  }
}
