import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Autocomplete,
  Button,
  FormField,
  Input,
  Modal,
  PageContainer,
  PageHeader,
  Pagination,
  Surface,
  pageCount,
  MAIN_CONTENT_ID,
} from '@/components/foundry';
import { AddIcon, DeleteIcon, TagIcon } from '@/components/icons';
import { TagNameInUseError, type TagWithCount } from '@/db/repositories';
import { useT } from '@/features/i18n';
import { PAGE_SIZE_BOUNDS, PAGE_SIZE_PRESETS } from '@/features/settings/settings';
import { useFormatters } from '@/lib/useFormatters';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useErrorMessage } from '@/features/errors';
import {
  useTagCount,
  useTagDictionary,
  useTagManagement,
  useTagNames,
  useTagSuggestions,
} from '../inventory/tags';

/**
 * Manage the freeform tag dictionary (issue #84): create, rename, merge and delete the tags
 * shared across items and locations. Tags are still created inline while editing an item or
 * location — this screen is the place to tidy the whole set: fix a typo, fold two near-duplicate
 * tags into one, or remove one that has outlived its use.
 *
 * The list pages **server-side** (the dictionary can outgrow one read, and every tag has to be
 * reachable from the screen that manages them), following the app-wide opt-in `Pagination` seam.
 */
export function TagsScreen() {
  const t = useT();
  const fmt = useFormatters();
  const paginated = usePreferencesStore((s) => s.paginateLists);
  const defaultPageSize = usePreferencesStore((s) => s.defaultPageSize);
  const setDefaultPageSize = usePreferencesStore((s) => s.setDefaultPageSize);

  const [page, setPage] = useState(1);
  // Unpaginated, the screen still reads a bounded page — the ceiling is the repository's, and
  // asking for more than it allows would silently clamp anyway.
  const pageSize = paginated ? defaultPageSize : PAGE_SIZE_BOUNDS.max;

  const dictionary = useTagDictionary(page, pageSize);
  const total = useTagCount();
  const { create } = useTagManagement();

  const [newName, setNewName] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const describeError = useErrorMessage();
  const [editing, setEditing] = useState<TagWithCount | null>(null);

  const tags = dictionary.data?.rows ?? [];
  // Fall back to the rows in hand when the count is unavailable, so a failed count query
  // degrades to "one page" rather than silently removing the pager from a longer list.
  const totalTags = total.data ?? (dictionary.data ? dictionary.data.offset + tags.length : 0);
  const pages = pageCount(totalTags, pageSize);
  // Unpaginated the read is capped at one page; how many tags that leaves unreachable.
  const hiddenTags = paginated ? 0 : Math.max(0, totalTags - tags.length);

  // Deleting or merging the last tag on the final page leaves the page out of range.
  useEffect(() => {
    if (paginated && pages > 0 && page > pages) setPage(pages);
  }, [paginated, pages, page]);

  const addTag = () => {
    const name = newName.trim();
    if (name.length === 0) return;
    setAddError(null);
    create.mutate(name, {
      onSuccess: () => {
        setNewName('');
        // A new tag sorts by name, so it may land on any page — go back to the first so the
        // list the user is looking at is the one their tag joined.
        setPage(1);
      },
      onError: (e) => setAddError(describeError(e, t('tags.add.error'))),
    });
  };

  return (
    <PageContainer>
      <PageHeader icon={<TagIcon />} title={t('tags.title')} />

      <main
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        className="flex flex-1 animate-rise flex-col gap-6 outline-none"
      >
        <p className="max-w-2xl text-sm text-muted-foreground">{t('tags.intro')}</p>

        <section aria-labelledby="tags-new-heading" className="flex flex-col gap-3">
          <h2 id="tags-new-heading" className="text-sm font-semibold text-foreground">
            {t('tags.add.heading')}
          </h2>
          <div className="flex items-start gap-2">
            <div className="flex-1">
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addTag();
                  }
                }}
                placeholder={t('tags.add.placeholder')}
                aria-label={t('tags.add.label')}
              />
            </div>
            <Button onClick={addTag} disabled={newName.trim().length === 0 || create.isPending}>
              <AddIcon aria-hidden />
              {t('tags.add.action')}
            </Button>
          </div>
          {addError ? (
            <p role="alert" className="text-sm text-destructive">
              {addError}
            </p>
          ) : null}
        </section>

        <section aria-labelledby="tags-list-heading" className="flex flex-col gap-3">
          <h2 id="tags-list-heading" className="text-sm font-semibold text-foreground">
            {t('tags.list.heading')}
          </h2>

          {dictionary.isLoading ? (
            <p className="text-sm text-muted-foreground">{t('tags.list.loading')}</p>
          ) : dictionary.isError ? (
            // Never fall through to the empty state on failure: "No tags yet" would be a lie,
            // and it hides a real error behind copy that reads like success.
            <Surface className="flex flex-col items-center gap-3 p-8 text-center">
              <p role="alert" className="text-sm text-destructive">
                {t('tags.list.error')}
              </p>
              <Button variant="outline" onClick={() => void dictionary.refetch()}>
                {t('tags.list.retry')}
              </Button>
            </Surface>
          ) : tags.length === 0 ? (
            <Surface className="flex flex-col items-center gap-2 p-8 text-center">
              <TagIcon aria-hidden className="size-8 text-muted-foreground/60" />
              <p className="text-sm text-muted-foreground">{t('tags.list.empty')}</p>
            </Surface>
          ) : (
            <>
              <ul className="flex flex-col gap-1.5">
                {tags.map((tag) => (
                  <li key={tag.id}>
                    <button
                      type="button"
                      onClick={() => setEditing(tag)}
                      className="flex w-full items-center gap-3 rounded-lg border border-border bg-card px-3 py-2 text-left transition-colors hover:bg-secondary"
                    >
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/15 px-2.5 py-1 text-sm font-medium text-primary [&_svg]:size-3.5">
                        <TagIcon aria-hidden />
                        {tag.name}
                      </span>
                      <span className="ml-auto text-xs text-muted-foreground">
                        {usageLabel(tag, fmt.quantity, t)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {paginated ? (
                <Pagination
                  page={page}
                  pageCount={pages}
                  onPageChange={setPage}
                  pageSize={defaultPageSize}
                  onPageSizeChange={setDefaultPageSize}
                  pageSizeOptions={PAGE_SIZE_PRESETS}
                  minPageSize={PAGE_SIZE_BOUNDS.min}
                  maxPageSize={PAGE_SIZE_BOUNDS.max}
                  totalItems={totalTags}
                  data-testid="tags-pagination"
                />
              ) : hiddenTags > 0 ? (
                // Unpaginated the read is still bounded, so say so rather than quietly showing a
                // truncated dictionary on the very screen meant to manage all of it.
                <p className="text-xs text-muted-foreground" data-testid="tags-truncated">
                  {t('tags.list.truncated', { vars: { count: hiddenTags, shown: tags.length } })}
                </p>
              ) : null}
            </>
          )}
        </section>
      </main>

      {editing ? <EditTagDialog tag={editing} onClose={() => setEditing(null)} /> : null}
    </PageContainer>
  );
}

/** "12 items · 3 locations", trimmed to only the non-zero parts, or "Unused" when on nothing. */
function usageLabel(tag: TagWithCount, quantity: (n: number) => string, t: ReturnType<typeof useT>): string {
  const parts: string[] = [];
  if (tag.itemCount > 0) {
    parts.push(t('tags.usage.items', { vars: { count: tag.itemCount, n: quantity(tag.itemCount) } }));
  }
  if (tag.locationCount > 0) {
    parts.push(
      t('tags.usage.locations', {
        vars: { count: tag.locationCount, n: quantity(tag.locationCount) },
      }),
    );
  }
  return parts.length > 0 ? parts.join(' · ') : t('tags.usage.unused');
}

/**
 * Manage a single tag: rename it, merge it into another tag, or delete it. Rename surfaces a
 * name clash as an offer to merge into the clashing tag; delete is a two-step confirm since it
 * strips the tag from every item and location that carries it.
 */
function EditTagDialog({ tag, onClose }: { tag: TagWithCount; onClose: () => void }) {
  const t = useT();
  const nameRef = useRef<HTMLInputElement>(null);
  const { rename, remove, merge } = useTagManagement();
  const [name, setName] = useState(tag.name);
  const [mergeQuery, setMergeQuery] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const describeError = useErrorMessage();
  const [clashTargetId, setClashTargetId] = useState<string | null>(null);

  // The merge target is picked from the **whole** dictionary, never from the page the list
  // happens to be showing — folding a typo into its correct spelling is the point of merging,
  // and the two rarely sort onto the same page. Typing runs the prefix query (which reaches
  // every tag); an empty box offers the first page as a starting point.
  const candidates = useTagNames();
  const matches = useTagSuggestions(mergeQuery);
  const query = mergeQuery.trim();
  const mergeTargets = useMemo(() => {
    const source = query.length > 0 ? (matches.data ?? []) : (candidates.data?.rows ?? []);
    return source.filter((x) => x.id !== tag.id);
  }, [query, matches.data, candidates.data, tag.id]);
  // Resolve the typed name back to a tag id; merging needs the id, and only an exact
  // (case-insensitive) name match counts as a chosen target.
  const mergeTarget = mergeTargets.find((x) => x.name.toLowerCase() === query.toLowerCase());

  const trimmed = name.trim();
  const renameDirty = trimmed.length > 0 && trimmed !== tag.name;
  const busy = rename.isPending || remove.isPending || merge.isPending;

  const submitRename = () => {
    if (!renameDirty) return;
    setError(null);
    setClashTargetId(null);
    rename.mutate(
      { id: tag.id, name: trimmed },
      {
        onSuccess: () => onClose(),
        onError: (e) => {
          if (e instanceof TagNameInUseError) {
            setClashTargetId(e.existingTagId);
            setError(t('tags.edit.rename.clash', { vars: { name: trimmed } }));
          } else {
            setError(describeError(e, t('tags.edit.rename.error')));
          }
        },
      },
    );
  };

  const doMerge = (targetId: string) => {
    if (targetId.length === 0) return;
    setError(null);
    merge.mutate({ sourceId: tag.id, targetId }, { onSuccess: () => onClose() });
  };

  const doDelete = () => {
    setError(null);
    remove.mutate(tag.id, { onSuccess: () => onClose() });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t('tags.edit.title')}
      description={t('tags.edit.description')}
      initialFocusRef={nameRef}
    >
      <div className="space-y-5">
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <FormField label={t('tags.edit.name')}>
              <Input
                ref={nameRef}
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submitRename()}
              />
            </FormField>
          </div>
          <Button onClick={submitRename} disabled={!renameDirty || busy}>
            {t('tags.edit.rename.action')}
          </Button>
        </div>

        {clashTargetId ? (
          <Button variant="outline" onClick={() => doMerge(clashTargetId)} disabled={busy}>
            {t('tags.edit.rename.mergeInstead')}
          </Button>
        ) : null}

        <div className="space-y-2 border-t border-border pt-4">
          <span className="block text-sm font-medium">{t('tags.edit.merge.heading')}</span>
          <p className="text-xs text-muted-foreground">
            {t('tags.edit.merge.explain', { vars: { name: tag.name } })}
          </p>
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <Autocomplete
                value={mergeQuery}
                onChange={setMergeQuery}
                suggestions={mergeTargets.map((x) => x.name)}
                placeholder={t('tags.edit.merge.choose')}
                aria-label={t('tags.edit.merge.label')}
              />
            </div>
            <Button
              variant="outline"
              onClick={() => mergeTarget && doMerge(mergeTarget.id)}
              disabled={!mergeTarget || busy}
            >
              {t('tags.edit.merge.action')}
            </Button>
          </div>
        </div>

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <div className="flex items-center justify-between gap-2 border-t border-border pt-4">
          {confirmingDelete ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">{t('tags.edit.delete.confirm')}</span>
              <Button variant="destructive" onClick={doDelete} disabled={busy}>
                {t('tags.edit.delete.action')}
              </Button>
              <Button variant="ghost" onClick={() => setConfirmingDelete(false)} disabled={busy}>
                {t('tags.edit.delete.keep')}
              </Button>
            </div>
          ) : (
            <Button variant="destructive" onClick={() => setConfirmingDelete(true)} disabled={busy}>
              <DeleteIcon aria-hidden />
              {t('tags.edit.delete.start')}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('tags.edit.close')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
