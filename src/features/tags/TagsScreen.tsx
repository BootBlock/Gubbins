import { useMemo, useRef, useState } from 'react';
import {
  Button,
  FormField,
  Input,
  Modal,
  PageContainer,
  PageHeader,
  Select,
  Surface,
  MAIN_CONTENT_ID,
} from '@/components/foundry';
import { AddIcon, DeleteIcon, TagIcon } from '@/components/icons';
import { TagNameInUseError, type TagWithCount } from '@/db/repositories';
import { useFormatters } from '@/lib/useFormatters';
import { useTagDictionary, useTagManagement } from '../inventory/tags';

/**
 * Manage the freeform tag dictionary (issue #84): create, rename, merge and delete the tags
 * shared across items and locations. Tags are still created inline while editing an item or
 * location — this screen is the place to tidy the whole set: fix a typo, fold two near-duplicate
 * tags into one, or remove one that has outlived its use.
 */
export function TagsScreen() {
  const fmt = useFormatters();
  const dictionary = useTagDictionary();
  const { create } = useTagManagement();
  const [newName, setNewName] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [editing, setEditing] = useState<TagWithCount | null>(null);

  const tags = dictionary.data?.rows ?? [];

  const addTag = () => {
    const name = newName.trim();
    if (name.length === 0) return;
    setAddError(null);
    create.mutate(name, {
      onSuccess: () => setNewName(''),
      onError: (e) => setAddError(e instanceof Error ? e.message : 'Could not add this tag.'),
    });
  };

  return (
    <PageContainer>
      <PageHeader icon={<TagIcon />} title="Tags" />

      <main
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        className="flex flex-1 animate-rise flex-col gap-6 outline-none"
      >
        <p className="max-w-2xl text-sm text-muted-foreground">
          Tags are freeform labels you can stick on any item or location — <em>fragile</em>, <em>on-loan</em>,{' '}
          <em>project-x</em>. The same tag is shared everywhere, so tidy the whole set here: rename one, merge
          two into a single tag, or delete one you no longer need.
        </p>

        <section aria-labelledby="tags-new-heading" className="flex flex-col gap-3">
          <h2 id="tags-new-heading" className="text-sm font-semibold text-foreground">
            Add a tag
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
                placeholder="e.g. fragile, RoHS, project-x"
                aria-label="New tag name"
              />
            </div>
            <Button onClick={addTag} disabled={newName.trim().length === 0 || create.isPending}>
              <AddIcon aria-hidden />
              Add tag
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
            All tags
          </h2>

          {dictionary.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading tags…</p>
          ) : dictionary.isError ? (
            // Never fall through to the empty state on failure: "No tags yet" would be a lie,
            // and it hides a real error behind copy that reads like success.
            <Surface className="flex flex-col items-center gap-3 p-8 text-center">
              <p role="alert" className="text-sm text-destructive">
                Your tags couldn’t be loaded.
              </p>
              <Button variant="outline" onClick={() => void dictionary.refetch()}>
                Try again
              </Button>
            </Surface>
          ) : tags.length === 0 ? (
            <Surface className="flex flex-col items-center gap-2 p-8 text-center">
              <TagIcon aria-hidden className="size-8 text-muted-foreground/60" />
              <p className="text-sm text-muted-foreground">
                No tags yet. Add one above, or tag an item or location and it will appear here.
              </p>
            </Surface>
          ) : (
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
                      {usageLabel(tag, fmt.quantity)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>

      {editing ? <EditTagDialog tag={editing} allTags={tags} onClose={() => setEditing(null)} /> : null}
    </PageContainer>
  );
}

/** "12 items · 3 locations", trimmed to only the non-zero parts, or "Unused" when on nothing. */
function usageLabel(tag: TagWithCount, quantity: (n: number) => string): string {
  const parts: string[] = [];
  if (tag.itemCount > 0) parts.push(`${quantity(tag.itemCount)} ${tag.itemCount === 1 ? 'item' : 'items'}`);
  if (tag.locationCount > 0) {
    parts.push(`${quantity(tag.locationCount)} ${tag.locationCount === 1 ? 'location' : 'locations'}`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'Unused';
}

/**
 * Manage a single tag: rename it, merge it into another tag, or delete it. Rename surfaces a
 * name clash as an offer to merge into the clashing tag; delete is a two-step confirm since it
 * strips the tag from every item and location that carries it.
 */
function EditTagDialog({
  tag,
  allTags,
  onClose,
}: {
  tag: TagWithCount;
  allTags: readonly TagWithCount[];
  onClose: () => void;
}) {
  const nameRef = useRef<HTMLInputElement>(null);
  const { rename, remove, merge } = useTagManagement();
  const [name, setName] = useState(tag.name);
  const [mergeTargetId, setMergeTargetId] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clashTargetId, setClashTargetId] = useState<string | null>(null);

  const trimmed = name.trim();
  const renameDirty = trimmed.length > 0 && trimmed !== tag.name;
  const otherTags = useMemo(() => allTags.filter((t) => t.id !== tag.id), [allTags, tag.id]);
  const mergeOptions = useMemo(
    () => [{ value: '', label: 'Choose a tag…' }, ...otherTags.map((t) => ({ value: t.id, label: t.name }))],
    [otherTags],
  );
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
            setError(`A tag named “${trimmed}” already exists. Merge this tag into it instead?`);
          } else {
            setError(e instanceof Error ? e.message : 'Could not rename this tag.');
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
      title="Edit tag"
      description="Rename this tag, merge it into another, or delete it from everywhere it is used."
      initialFocusRef={nameRef}
    >
      <div className="space-y-5">
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <FormField label="Name">
              <Input
                ref={nameRef}
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submitRename()}
              />
            </FormField>
          </div>
          <Button onClick={submitRename} disabled={!renameDirty || busy}>
            Rename
          </Button>
        </div>

        {clashTargetId ? (
          <Button variant="outline" onClick={() => doMerge(clashTargetId)} disabled={busy}>
            Merge into the existing tag
          </Button>
        ) : null}

        <div className="space-y-2 border-t border-border pt-4">
          <span className="block text-sm font-medium">Merge into another tag</span>
          <p className="text-xs text-muted-foreground">
            Move every item and location tagged “{tag.name}” onto the chosen tag, then remove “{tag.name}”.
            This can’t be undone.
          </p>
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <Select
                value={mergeTargetId}
                onChange={setMergeTargetId}
                options={mergeOptions}
                aria-label="Tag to merge into"
              />
            </div>
            <Button
              variant="outline"
              onClick={() => doMerge(mergeTargetId)}
              disabled={mergeTargetId.length === 0 || busy}
            >
              Merge
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
              <span className="text-sm text-muted-foreground">Delete this tag everywhere?</span>
              <Button variant="destructive" onClick={doDelete} disabled={busy}>
                Delete
              </Button>
              <Button variant="ghost" onClick={() => setConfirmingDelete(false)} disabled={busy}>
                Keep
              </Button>
            </div>
          ) : (
            <Button variant="destructive" onClick={() => setConfirmingDelete(true)} disabled={busy}>
              <DeleteIcon aria-hidden />
              Delete tag
            </Button>
          )}
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Close
          </Button>
        </div>
      </div>
    </Modal>
  );
}
