/**
 * Engine smoke tests for {@link startPrecip}. The test DOM has no real 2D canvas context, so we
 * inject a recording stub and drive `requestAnimationFrame` by hand. These verify the actual engine
 * code path the component wiring can't: that it runs frames without throwing, advances particles,
 * rotates rain streaks and near snow crystals (but blits distant grains plainly), and honours the
 * reduced-motion static-frame gate. Depth (`Math.random`) is pinned where a specific sprite variant
 * is under test, so the grain-vs-crystal path is exercised deterministically rather than by chance.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { startPrecip } from './precip-engine';
import { NO_SURFACE, type HoverFollow, type SurfaceTracker } from './surface-map';

interface DrawCall {
  args: unknown[];
}

/** A recording 2D-context stub capturing the calls the engine makes. */
function makeCtx() {
  const translates: Array<[number, number]> = [];
  const drawImages: DrawCall[] = [];
  const drawAlphas: number[] = [];
  let rotateCount = 0;
  let clearCount = 0;
  const ctx = {
    globalAlpha: 1,
    setTransform: () => {},
    clearRect: () => {
      clearCount++;
    },
    save: () => {},
    restore: () => {},
    translate: (x: number, y: number) => {
      translates.push([x, y]);
    },
    rotate: () => {
      rotateCount++;
    },
    drawImage: (...args: unknown[]) => {
      drawImages.push({ args });
      drawAlphas.push(ctx.globalAlpha); // the alpha set immediately before this blit
    },
  };
  return {
    ctx,
    translates,
    drawImages,
    drawAlphas,
    get rotateCount() {
      return rotateCount;
    },
    get clearCount() {
      return clearCount;
    },
  };
}

/** A canvas stub whose `getContext` returns our recorder. */
function makeCanvas(rec: ReturnType<typeof makeCtx>) {
  return {
    getContext: () => rec.ctx,
    clientWidth: 1200,
    clientHeight: 800,
    width: 0,
    height: 0,
  } as unknown as HTMLCanvasElement;
}

// Manual rAF pump so frames advance deterministically.
let rafQueue: FrameRequestCallback[] = [];
let rafSeq = 0;

function pump(now: number) {
  const due = rafQueue;
  rafQueue = [];
  for (const cb of due) cb(now);
}

beforeEach(() => {
  rafQueue = [];
  rafSeq = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return ++rafSeq;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('startPrecip', () => {
  it('returns a no-op controller when there is no 2D context', () => {
    const canvas = { getContext: () => null } as unknown as HTMLCanvasElement;
    const ctrl = startPrecip(canvas, { kind: 'rain', reduced: false });
    expect(() => {
      ctrl.refresh();
      ctrl.stop();
    }).not.toThrow();
  });

  it('runs animated frames and advances the field (rain)', () => {
    const rec = makeCtx();
    const ctrl = startPrecip(makeCanvas(rec), { kind: 'rain', reduced: false });
    // First frame (dt=0, primes lastTime) then a couple of real steps.
    pump(0);
    pump(16);
    pump(32);
    expect(rec.drawImages.length).toBeGreaterThan(0);
    expect(rec.clearCount).toBeGreaterThanOrEqual(3);
    // Rain rotates each streak to its velocity.
    expect(rec.rotateCount).toBeGreaterThan(0);
    // Particles actually move: the translate positions are not all identical across frames.
    const uniqueY = new Set(rec.translates.map(([, y]) => Math.round(y)));
    expect(uniqueY.size).toBeGreaterThan(1);
    ctrl.stop();
  });

  it('falls in depth layers — near drops fall faster than far/back ones (parallax)', () => {
    // Pin depth so every drop shares one z, then measure how far particle 0 falls in one 16ms
    // step. Rain's vertical velocity is the pure depth-scaled fall speed (no vertical turbulence),
    // so a near layer must advance markedly more than a far one. The 0.1 sample also falls below
    // deepLayerFraction, so those drops land in a deep-background layer — slower still, which only
    // widens the gap the assertion checks.
    const fallOverOneStep = (z: number): number => {
      vi.spyOn(Math, 'random').mockReturnValue(z);
      rafQueue = [];
      const rec = makeCtx();
      const ctrl = startPrecip(makeCanvas(rec), { kind: 'rain', reduced: false });
      pump(16); // dt = 0 (primes lastTime); draws the field at its start positions
      pump(32); // dt = 16ms; the field falls one step
      ctrl.stop();
      vi.restoreAllMocks();
      const perFrame = rec.translates.length / 2; // rain draws every particle via translate
      const yStart = rec.translates[0][1];
      const yAfterStep = rec.translates[perFrame][1];
      return yAfterStep - yStart;
    };
    const near = fallOverOneStep(0.9);
    const far = fallOverOneStep(0.1);
    expect(near).toBeGreaterThan(0);
    expect(far).toBeGreaterThan(0);
    expect(near).toBeGreaterThan(far * 1.8);
  });

  it('has deep-background layers that fall slower than the main field', () => {
    // How far particle 0 falls in one 16ms step for a pinned depth sample.
    const fallOverOneStep = (sample: number): number => {
      vi.spyOn(Math, 'random').mockReturnValue(sample);
      rafQueue = [];
      const rec = makeCtx();
      const ctrl = startPrecip(makeCanvas(rec), { kind: 'rain', reduced: false });
      pump(16);
      pump(32);
      ctrl.stop();
      vi.restoreAllMocks();
      const perFrame = rec.translates.length / 2;
      return rec.translates[perFrame][1] - rec.translates[0][1];
    };
    // 0.05 < deepLayerFraction → every drop spawns in a deep-background layer (depth < 0).
    const deep = fallOverOneStep(0.05);
    // 0.2 ≥ deepLayerFraction → main field, and near its slow back edge.
    const mainBack = fallOverOneStep(0.2);
    expect(deep).toBeGreaterThan(0); // still falling, not frozen or reversed
    expect(deep).toBeLessThan(mainBack); // …but slower than the main field's back layer
  });

  it('lifts the opacity of deep-background drops so they stay visible', () => {
    // 0.05 < deepLayerFraction → every drop spawns in a deep-background layer (depth ≈ -0.12).
    vi.spyOn(Math, 'random').mockReturnValue(0.05);
    const rec = makeCtx();
    const ctrl = startPrecip(makeCanvas(rec), { kind: 'rain', reduced: false });
    pump(16); // one draw pass
    ctrl.stop();
    vi.restoreAllMocks();
    // The raw depth-driven alpha at that depth is ≈0.11 (near-invisible); the deep-layer boost
    // lifts every deep drop well past it, so this fails if the boost is ever dropped.
    expect(rec.drawAlphas.length).toBeGreaterThan(0);
    for (const a of rec.drawAlphas) expect(a).toBeGreaterThan(0.15);
  });

  it('rotates near snow crystals around their centre', () => {
    // Depth ≥ grainMaxZ → every flake spawns as a rotating crystal.
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    const rec = makeCtx();
    const ctrl = startPrecip(makeCanvas(rec), { kind: 'snow', reduced: false });
    pump(0);
    pump(16);
    expect(rec.drawImages.length).toBeGreaterThan(0);
    expect(rec.rotateCount).toBeGreaterThan(0); // crystals rotate
    expect(rec.translates.length).toBeGreaterThan(0); // …about a translated centre
    ctrl.stop();
  });

  it('blits distant snow grains plainly (no rotation) and advances them', () => {
    // Depth < grainMaxZ → every flake spawns as a plain grain.
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const rec = makeCtx();
    const ctrl = startPrecip(makeCanvas(rec), { kind: 'snow', reduced: false });
    pump(0);
    pump(16);
    pump(32);
    expect(rec.drawImages.length).toBeGreaterThan(0);
    expect(rec.rotateCount).toBe(0);
    expect(rec.translates.length).toBe(0); // grains blit at absolute coords
    // They fall: the y arg of drawImage changes across frames.
    const uniqueY = new Set(rec.drawImages.map((d) => Math.round(d.args[2] as number)));
    expect(uniqueY.size).toBeGreaterThan(1);
    ctrl.stop();
  });

  it('paints a single static frame and never loops under reduced motion', () => {
    const rec = makeCtx();
    const ctrl = startPrecip(makeCanvas(rec), { kind: 'rain', reduced: true });
    expect(rec.drawImages.length).toBeGreaterThan(0); // one calm frame drawn
    expect(rafQueue.length).toBe(0); // no animation loop scheduled
    ctrl.stop();
  });
});

/**
 * A controllable surface-map stub: every column reports the same control top, clearable (with a
 * generation bump and a fresh array, mirroring the real tracker's swap-don't-mutate contract) to
 * simulate the layout moving under settled snow. Wider than the 1200px stub viewport so
 * particles drifting through the off-screen wrap margin still sit over a column.
 */
function makeSurfaces(top: number, cols = 340) {
  let tops = new Int16Array(cols).fill(top);
  let generation = 1;
  let hover: HoverFollow | null = null;
  const tracker: SurfaceTracker = {
    snapshot: () => ({ tops, generation }),
    hoverFollow: () => hover,
    stop: () => {},
  };
  return {
    tracker,
    factory: () => tracker,
    clear() {
      tops = new Int16Array(cols).fill(NO_SURFACE);
      generation++;
    },
    setHover(next: HoverFollow | null) {
      hover = next;
    },
  };
}

describe('startPrecip control interaction (issue #68)', () => {
  it('settles near snow into mounds on control tops (overlay blits the mound layer)', () => {
    // Depth pinned to 0.9 → every flake is a near crystal, well above the settle threshold.
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    const rec = makeCtx();
    const orec = makeCtx();
    const overlay = makeCanvas(orec);
    const surfaces = makeSurfaces(400);
    const ctrl = startPrecip(makeCanvas(rec), {
      kind: 'snow',
      reduced: false,
      overlay,
      surfaces: surfaces.factory,
    });
    // Long pump: flakes spawned below the surface line must recycle off-screen, respawn above,
    // and fall back down to the control top before the first landing can happen.
    for (let i = 1; i <= 250; i++) pump(i * 50);
    expect(orec.drawImages.length).toBeGreaterThan(0); // settled snow is being composited
    expect(orec.clearCount).toBeGreaterThan(0); // the overlay is cleared every frame
    ctrl.stop();
  });

  it('knocks settled snow off when the layout under it moves', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    const rec = makeCtx();
    const orec = makeCtx();
    const surfaces = makeSurfaces(400);
    const ctrl = startPrecip(makeCanvas(rec), {
      kind: 'snow',
      reduced: false,
      overlay: makeCanvas(orec),
      surfaces: surfaces.factory,
    });
    for (let i = 1; i <= 250; i++) pump(i * 50);
    expect(orec.drawImages.length).toBeGreaterThan(0);
    // The world moves: every surface top changes beyond the tolerance → all depths reset. If the
    // reset were ever dropped, the engine would keep compositing the (stale) mound layer every
    // frame and this assertion would fail.
    surfaces.clear();
    const before = orec.drawImages.length;
    pump(250 * 50 + 50);
    pump(250 * 50 + 100);
    expect(orec.drawImages.length).toBe(before); // the settled snow was knocked off
    ctrl.stop();
  });

  it("rides a hovered control's lift: settled snow is blitted shifted by the hover offset", () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    const rec = makeCtx();
    const orec = makeCtx();
    const surfaces = makeSurfaces(400);
    const ctrl = startPrecip(makeCanvas(rec), {
      kind: 'snow',
      reduced: false,
      overlay: makeCanvas(orec),
      surfaces: surfaces.factory,
    });
    for (let i = 1; i <= 250; i++) pump(i * 50);
    // At rest the mound layer is one full-canvas blit (5-arg drawImage), never shifted.
    const restMark = orec.drawImages.length;
    pump(250 * 50 + 50);
    const restFrame = orec.drawImages.slice(restMark);
    expect(restFrame.length).toBeGreaterThan(0);
    expect(restFrame.every((d) => d.args.length === 5)).toBe(true);
    // Hover a mid-screen control span, lifted 4px up: its columns are drawn as a shifted slice
    // (9-arg drawImage(img, sx,sy,sw,sh, dx,dy,dw,dh) — dest-y at index 6 is -4) while the rest
    // stays at rest.
    surfaces.setHover({ c0: 40, c1: 60, dy: -4 });
    const mark = orec.drawImages.length;
    pump(250 * 50 + 100);
    const frame = orec.drawImages.slice(mark);
    expect(frame.some((d) => d.args.length === 9 && d.args[6] === -4)).toBe(true);
    // Releasing (no hover) returns to the single unshifted full-canvas blit.
    surfaces.setHover(null);
    const mark2 = orec.drawImages.length;
    pump(250 * 50 + 150);
    const frame2 = orec.drawImages.slice(mark2);
    expect(frame2.every((d) => d.args.length === 5)).toBe(true);
    ctrl.stop();
  });

  it('splashes near rain drops off control tops (overlay plays splash frames)', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    const rec = makeCtx();
    const orec = makeCtx();
    const surfaces = makeSurfaces(400);
    const ctrl = startPrecip(makeCanvas(rec), {
      kind: 'rain',
      reduced: false,
      overlay: makeCanvas(orec),
      surfaces: surfaces.factory,
    });
    // Long pump: with Math.random pinned, every drop shares one trajectory, so the field crosses
    // the surface line in lockstep a handful of times — enough for at least one on-map hit.
    for (let i = 1; i <= 250; i++) pump(i * 50);
    expect(orec.drawImages.length).toBeGreaterThan(0); // splash sprites blitted above the UI
    ctrl.stop();
  });

  it('leaves the overlay untouched without surfaces (columns report no surface)', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    const rec = makeCtx();
    const orec = makeCtx();
    const surfaces = makeSurfaces(400);
    surfaces.clear();
    const ctrl = startPrecip(makeCanvas(rec), {
      kind: 'rain',
      reduced: false,
      overlay: makeCanvas(orec),
      surfaces: surfaces.factory,
    });
    for (let i = 1; i <= 60; i++) pump(i * 50);
    expect(orec.drawImages.length).toBe(0); // nothing to land on → nothing drawn above the UI
    ctrl.stop();
  });

  it('keeps the interaction layer fully inert under reduced motion', () => {
    const rec = makeCtx();
    const orec = makeCtx();
    const surfaces = makeSurfaces(400);
    const ctrl = startPrecip(makeCanvas(rec), {
      kind: 'snow',
      reduced: true,
      overlay: makeCanvas(orec),
      surfaces: surfaces.factory,
    });
    expect(rec.drawImages.length).toBeGreaterThan(0); // the calm static frame still paints
    expect(orec.drawImages.length).toBe(0); // …but the overlay is never touched
    expect(orec.clearCount).toBe(0);
    ctrl.stop();
  });
});
