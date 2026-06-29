import { useRef, useState } from 'react';

/**
 * The inline rename editor (F2): an uncontrolled-feeling text field that commits on
 * Enter / blur and abandons on Escape. Its keydown is stopped from bubbling so the
 * tree container's roving-navigation handler never sees the typing, and a `done`
 * latch prevents the trailing blur from double-firing after an Enter/Escape.
 */
export function LocationInlineRename({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);

  const commit = () => {
    if (done.current) return;
    done.current = true;
    const trimmed = value.trim();
    if (trimmed.length > 0 && trimmed !== initial) onCommit(trimmed);
    else onCancel();
  };

  return (
    <input
      autoFocus
      aria-label={`Rename ${initial}`}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          done.current = true;
          onCancel();
        }
      }}
      className="min-w-0 flex-1 rounded border border-primary/40 bg-background px-1.5 py-0.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
    />
  );
}
