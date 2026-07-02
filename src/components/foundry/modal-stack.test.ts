import { describe, it, expect } from 'vitest';
import { pushModal, popModal, isTopModal, openModalCount } from './modal-stack';

describe('modal-stack', () => {
  it('tracks a single modal as the top', () => {
    const a = pushModal();
    expect(isTopModal(a)).toBe(true);
    expect(openModalCount()).toBe(1);
    popModal(a);
    expect(isTopModal(a)).toBe(false);
    expect(openModalCount()).toBe(0);
  });

  it('only the most recently opened modal is the top', () => {
    const parent = pushModal();
    const nested = pushModal();
    expect(isTopModal(parent)).toBe(false);
    expect(isTopModal(nested)).toBe(true);
    popModal(nested);
    popModal(parent);
  });

  it('restores the parent as top when the nested modal closes', () => {
    const parent = pushModal();
    const nested = pushModal();
    popModal(nested);
    expect(isTopModal(parent)).toBe(true);
    popModal(parent);
  });

  it('tolerates out-of-order and repeated release', () => {
    const parent = pushModal();
    const nested = pushModal();
    popModal(parent); // parent unmounts first (e.g. the whole tree is torn down)
    expect(isTopModal(nested)).toBe(true);
    popModal(nested);
    popModal(nested); // double release is a no-op
    expect(openModalCount()).toBe(0);
  });
});
