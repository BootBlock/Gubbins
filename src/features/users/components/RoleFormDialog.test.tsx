/**
 * Component tests for the role editor's permission grid (issue #429).
 *
 * The defect these pin down was visual and silent: the grid rendered each subject's actions in
 * declaration order, so the audit trail's **Delete** box sat in the column Items used for
 * **Change**. Nothing failed — the right key was still toggled — but a reader ticking down a
 * column granted four different things and had no way to notice.
 *
 * So the assertions here are about *placement and naming*, not about grant maths (which
 * `role-grants.test.ts` owns): every checkbox announces the subject and action it truly toggles,
 * a subject with no action in a column leaves that cell empty, and the copy the registry
 * promises is actually rendered rather than appearing as a raw catalog key.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RoleFormDialog } from './RoleFormDialog';
import { PERMISSION_SUBJECT_IDS, permissionKeyInSlot } from '../permission-registry';
import { EN_CATALOG } from '@/features/i18n/messages';

vi.mock('@/components/icons', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/icons')>();
  return Object.fromEntries(Object.keys(actual).map((k) => [k, () => <span data-testid={`icon-${k}`} />]));
});

afterEach(cleanup);

function renderDialog(permissions: readonly string[] = []) {
  const onSubmit = vi.fn();
  render(
    <RoleFormDialog
      role={
        {
          id: 'r1',
          name: 'Workshop lead',
          description: null,
          permissions: [...permissions],
          isBuiltin: false,
        } as never
      }
      busy={false}
      error={null}
      onSubmit={onSubmit}
      onClose={vi.fn()}
    />,
  );
  return { onSubmit };
}

describe('role editor permission grid', () => {
  it('renders one checkbox per permission key, and none for a slot a subject lacks', () => {
    renderDialog();
    for (const subject of PERMISSION_SUBJECT_IDS) {
      for (const slot of ['view', 'change', 'delete'] as const) {
        const key = permissionKeyInSlot(subject, slot);
        const box = screen.queryByTestId(`role-permission-${subject}:${slot === 'view' ? 'read' : slot}`);
        if (key) {
          // The cell exists under the key's *real* action name, whatever the column is called.
          expect(screen.getByTestId(`role-permission-${key}`), `${subject} ${slot}`).toBeTruthy();
        } else {
          // An empty cell is the point: it is what stops a column meaning two things.
          expect(box, `${subject} should have no ${slot} box`).toBeNull();
        }
      }
    }
  });

  it('leaves the audit trail’s Change cell empty, which is the misalignment that motivated slots', () => {
    renderDialog();
    expect(screen.getByTestId('role-permission-audit:view')).toBeTruthy();
    expect(screen.getByTestId('role-permission-audit:delete')).toBeTruthy();
    expect(screen.queryByTestId('role-permission-audit:write')).toBeNull();
    // Items fills all three, so the two rows can only line up if audit leaves a gap.
    expect(screen.getByTestId('role-permission-items:write')).toBeTruthy();
  });

  it('names every checkbox by its subject and its true action', () => {
    renderDialog();
    // `users:manage` sits in the Change column but is not called Change — the accessible name
    // must say Manage, or a screen-reader user is told the box does something broader.
    expect(screen.getByTestId('role-permission-users:manage').getAttribute('aria-label')).toBe(
      'Users and roles — Manage',
    );
    expect(screen.getByTestId('role-permission-items:delete').getAttribute('aria-label')).toBe(
      'Items — Delete',
    );
    expect(screen.getByTestId('role-permission-labels:print').getAttribute('aria-label')).toBe(
      'Labels and printing — Print',
    );
  });

  it('captions the cells whose action is narrower than their column, and no others', () => {
    renderDialog();
    const captioned = ['Manage', 'Run', 'Print'];
    for (const caption of captioned) {
      expect(screen.getAllByText(caption).length, caption).toBeGreaterThan(0);
    }
  });

  it('renders real copy for every subject, never a raw catalog key', () => {
    renderDialog();
    for (const subject of PERMISSION_SUBJECT_IDS) {
      const label = EN_CATALOG[`users.subject.${subject}`];
      expect(typeof label, subject).toBe('string');
      expect(screen.getAllByText(label as string).length, subject).toBeGreaterThan(0);
    }
    expect(screen.queryByText(/^users\.subject\./)).toBeNull();
    expect(screen.queryByText(/^users\.slot\./)).toBeNull();
  });

  it('offers a help badge for every subject row and every column heading', () => {
    renderDialog();
    // One per subject, plus one per column heading. The badge's accessible name is deliberately
    // the generic "More information" (see the InfoHint contract), so counting is the check.
    const hints = screen.getAllByLabelText('More information');
    expect(hints.length).toBe(PERMISSION_SUBJECT_IDS.length + 3 + 2);
  });

  it('disables the grid while “allow everything” is set, rather than ticking every box', () => {
    renderDialog(['*']);
    const everything = screen.getByTestId('role-grants-everything') as HTMLInputElement;
    expect(everything.checked).toBe(true);
    // Ticked-looking but inert: un-ticking one box cannot express "everything except", so the
    // grid is held rather than pretending the wildcard is a set of keys. The hold comes from the
    // enclosing `<fieldset disabled>`, which is why the input's own `disabled` stays false — that
    // IDL property reflects the element's own attribute, not the effective state.
    const box = screen.getByTestId('role-permission-items:read') as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(box.closest('fieldset')?.disabled).toBe(true);
  });

  it('submits the exact keys ticked, including the ones the grid captions', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderDialog(['items:read']);

    await user.click(screen.getByTestId('role-permission-labels:print'));
    await user.click(screen.getByTestId('role-permission-checkouts:delete'));
    await user.click(screen.getByRole('button', { name: EN_CATALOG['roles.form.save'] as string }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0].permissions).toEqual(['items:read', 'checkouts:delete', 'labels:print']);
  });

  it('keeps a grant this build does not recognise, and says so', () => {
    renderDialog(['items:read', 'sorcery:cast']);
    const banner = screen.getByText(/doesn’t recognise/i);
    expect(within(banner).queryByText(/sorcery/)).toBeNull();
  });
});
