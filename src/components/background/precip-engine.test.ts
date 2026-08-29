/**
 * Engine smoke tests for {@link startPrecip}. The test DOM has no real 2D canvas context, so we
 * inject a recording stub and drive `requestAnimationFrame` by hand. These verify the actual engine
 * code path the component wiring can't: that it runs frames without throwing, advances particles,
 * rotates rain streaks and near snow crystals (but blits distant grains plainly), and honours the
 * reduced-motion static-frame gate. Depth (`Math.random`) is pinned where a specific sprite variant
 * is under test, so the grain-vs-crystal path is exercised deterministically rather than by chance.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  startPrecip,
  snowSideStickChance,
  snowUnderCatchChance,
  snowMoundCapacity,
  snowSettleChance,
} from './precip-engine';
import { blizzard } from './flow-field';
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
  let fillCount = 0;
  const ctx = {
    globalAlpha: 1,
    fillStyle: '',
    setTransform: () => {},
    clearRect: () => {
      clearCount++;
    },
    // The thundersnow flash is a plain full-canvas fill.
    fillRect: () => {
      fillCount++;
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
    get fillCount() {
      return fillCount;
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
    // Depth < grainMaxZ → every flake spawns as a plain grain. (0.3, not lower: a sample under
    // the deep-layer fraction would land the whole field in the slow deep background, whose
    // sub-pixel per-frame fall the rounding check below couldn't see.)
    vi.spyOn(Math, 'random').mockReturnValue(0.3);
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
  // Undersides sit below the fold in these tests (NO_SURFACE), so top-landing behaviour is
  // exercised in isolation from the underside-catch path.
  let bots = new Int16Array(cols).fill(NO_SURFACE);
  let generation = 1;
  let hover: HoverFollow | null = null;
  const tracker: SurfaceTracker = {
    snapshot: () => ({ tops, bots, generation }),
    hoverFollow: () => hover,
    stop: () => {},
  };
  let created = 0;
  return {
    tracker,
    factory: () => {
      created++;
      return tracker;
    },
    /** How many times the engine actually built a tracker (it takes a factory, not an instance). */
    get created() {
      return created;
    },
    clear() {
      tops = new Int16Array(cols).fill(NO_SURFACE);
      bots = new Int16Array(cols).fill(NO_SURFACE);
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
    expect(orec.clearCount).toBeGreaterThan(0); // …over a cleared overlay
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
    // The world moves: every surface top changes beyond the tolerance, so the settled snow is
    // knocked off and the overlay stops compositing it. The change dirties the mound cache too, so
    // the assertion is only meaningful once a re-render has had the chance to happen — hence
    // pumping well past `renderInterval` (0.15s) rather than a single frame.
    //
    // Note what this does *not* prove: with every top gone the columns are `NO_SURFACE`, which
    // `renderMounds` skips whatever depth they hold, so the per-column depth reset itself is not
    // observable here. A test that pins that down would move only *some* surfaces.
    surfaces.clear();
    const before = orec.drawImages.length;
    for (let i = 251; i <= 260; i++) pump(i * 50);
    expect(orec.drawImages.length).toBe(before); // the settled snow was knocked off
    ctrl.stop();
  });

  it('repaints the overlay when the mound cache itself changes, not only when the lift does', () => {
    // The resting skip has two halves: "the lift is unchanged" and "the cache is unchanged". The
    // lift half is covered by the test below; this is the cache half, and a theme change is the
    // sharpest way to drive it — `refresh()` re-reads the token colours and dirties the mound
    // cache, but knocks nothing off, so the snow on screen must simply be repainted in the new
    // colour. Drop the generation bump in `renderMounds` and this is where it shows: the overlay
    // would hold the old colour for as long as the snow lasts, because every frame after the
    // first would look unchanged to the guard.
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
    // Settle into the quiet state first, so the assertion below cannot be satisfied by a repaint
    // that was going to happen anyway.
    const quietMark = orec.drawImages.length;
    pump(250 * 50 + 50);
    pump(250 * 50 + 100);
    expect(orec.drawImages.slice(quietMark)).toEqual([]);
    // Now the cache changes underneath an unchanged lift. Pump past `renderInterval` (0.15s).
    ctrl.refresh();
    const mark = orec.drawImages.length;
    for (let i = 253; i <= 262; i++) pump(i * 50);
    expect(orec.drawImages.slice(mark).length).toBeGreaterThan(0);
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
    // At rest the mound layer is one full-canvas blit (5-arg drawImage), never shifted — and it is
    // drawn once, not per frame: with the cache unchanged and no lift to follow, every further
    // frame would be identical to the one on screen, so the overlay pass skips itself entirely
    // (issue #419). Drop that skip and `restFrame` fills up again.
    const restMark = orec.drawImages.length;
    pump(250 * 50 + 50);
    pump(250 * 50 + 100);
    const restFrame = orec.drawImages.slice(restMark);
    expect(restFrame).toEqual([]);
    // Hover a mid-screen control span, lifted 4px up: its columns are drawn as a shifted slice
    // (9-arg drawImage(img, sx,sy,sw,sh, dx,dy,dw,dh) — dest-y at index 6 is -4) while the rest
    // stays at rest. A changed lift is a changed frame, so the skip above must not swallow it.
    surfaces.setHover({ c0: 40, c1: 60, dy: -4 });
    const mark = orec.drawImages.length;
    pump(250 * 50 + 150);
    const frame = orec.drawImages.slice(mark);
    expect(frame.some((d) => d.args.length === 9 && d.args[6] === -4)).toBe(true);
    // Holding the same lift is again a still frame, so it too stops redrawing.
    const heldMark = orec.drawImages.length;
    pump(250 * 50 + 200);
    expect(orec.drawImages.slice(heldMark)).toEqual([]);
    // Releasing (no hover) redraws once, as the single unshifted full-canvas blit.
    surfaces.setHover(null);
    const mark2 = orec.drawImages.length;
    pump(250 * 50 + 250);
    const frame2 = orec.drawImages.slice(mark2);
    expect(frame2.length).toBeGreaterThan(0);
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

/**
 * The seasonal garnish. `suppressBase` is the lever these lean on: with the rain/snow pool empty
 * every recorded blit is necessarily a garnish piece, so the assertions can be exact counts rather
 * than "more than before". The garnish runs `dense` here so its spawn delays expire within a few
 * pumped frames instead of the sparse gap the app ships.
 */
describe('startPrecip seasonal garnish', () => {
  const GARNISH = { emoji: ['🎃', '👻'], dense: true } as const;

  it('blits the garnish, and only the garnish, when the base field is suppressed', () => {
    const rec = makeCtx();
    const ctrl = startPrecip(makeCanvas(rec), {
      kind: 'snow',
      reduced: false,
      garnish: GARNISH,
      suppressBase: true,
    });
    // Nothing is drawn until the pieces' spawn delays run out.
    for (let i = 1; i <= 40; i++) pump(i * 50);
    expect(rec.drawImages.length).toBeGreaterThan(0);
    // Every piece rocks around its own centre, so a blit is always inside a translate+rotate pair.
    expect(rec.rotateCount).toBeGreaterThan(0);
    expect(rec.translates.length).toBe(rec.drawImages.length);
    ctrl.stop();
  });

  it('advances the garnish across frames rather than holding it still', () => {
    const rec = makeCtx();
    const ctrl = startPrecip(makeCanvas(rec), {
      kind: 'snow',
      reduced: false,
      garnish: GARNISH,
      suppressBase: true,
    });
    for (let i = 1; i <= 40; i++) pump(i * 50);
    const first = rec.translates[0];
    const last = rec.translates[rec.translates.length - 1];
    expect(first).toBeDefined();
    expect(last).not.toEqual(first);
    ctrl.stop();
  });

  it('draws no garnish under reduced motion (it is pure motion, not a static decoration)', () => {
    const rec = makeCtx();
    const ctrl = startPrecip(makeCanvas(rec), {
      kind: 'snow',
      reduced: true,
      garnish: GARNISH,
      suppressBase: true,
    });
    // A reduced start paints one static frame; with the base pool suppressed and the garnish
    // gated off, that frame has nothing at all to draw.
    expect(rec.drawImages.length).toBe(0);
    for (let i = 1; i <= 10; i++) pump(i * 50);
    expect(rec.drawImages.length).toBe(0);
    ctrl.stop();
  });

  it('ignores an empty emoji set rather than allocating an unusable pool', () => {
    const rec = makeCtx();
    const ctrl = startPrecip(makeCanvas(rec), {
      kind: 'snow',
      reduced: false,
      garnish: { emoji: [] },
      suppressBase: true,
    });
    for (let i = 1; i <= 20; i++) pump(i * 50);
    expect(rec.drawImages.length).toBe(0);
    ctrl.stop();
  });

  it('skips the control-surface tracker entirely on a garnish-only run', () => {
    const rec = makeCtx();
    const orec = makeCtx();
    const surfaces = makeSurfaces(400);
    // Nothing can settle or splash without a base field, so the tracker — and the document-wide
    // observers it installs — must never be constructed.
    const ctrl = startPrecip(makeCanvas(rec), {
      kind: 'snow',
      reduced: false,
      overlay: makeCanvas(orec),
      surfaces: surfaces.factory,
      garnish: GARNISH,
      suppressBase: true,
    });
    for (let i = 1; i <= 40; i++) pump(i * 50);
    expect(surfaces.created).toBe(0);
    expect(orec.drawImages.length).toBe(0);
    ctrl.stop();
  });

  it('still garnishes a normal snow field (the shipped case: a garnish, not a replacement)', () => {
    const plain = makeCtx();
    const plainCtrl = startPrecip(makeCanvas(plain), { kind: 'snow', reduced: false });
    for (let i = 1; i <= 40; i++) pump(i * 50);
    const plainPerFrame = plain.drawImages.length;
    plainCtrl.stop();

    const rec = makeCtx();
    const ctrl = startPrecip(makeCanvas(rec), {
      kind: 'snow',
      reduced: false,
      garnish: GARNISH,
    });
    for (let i = 1; i <= 40; i++) pump(i * 50);
    // The snow pool is untouched — the garnish is added on top of it, never carved out of it.
    expect(rec.drawImages.length).toBeGreaterThan(plainPerFrame);
    ctrl.stop();
  });
});

/**
 * The widened snow parallax range and the blizzard scheduler (issue #455). Depth is pinned via
 * Math.random, so every spawn sample collapses to one value: a pin under the deep-layer fraction
 * puts the whole field in the deep background (z < 0), a pin above 1 − bokeh.fraction puts it in
 * the foreground bokeh layer (z > 1), and anything between is the main-field depth itself.
 */
describe('startPrecip snow depth & weather (issue #455)', () => {
  /** Mean per-step fall (css px over one 16ms frame) of a pinned-depth snow field. */
  const meanFall = (pin: number) => {
    vi.spyOn(Math, 'random').mockReturnValue(pin);
    rafQueue = [];
    const rec = makeCtx();
    const ctrl = startPrecip(makeCanvas(rec), { kind: 'snow', reduced: false });
    pump(16); // dt = 0 (primes lastTime); draws the field at its start positions
    pump(32); // dt = 16ms; the field falls one step
    ctrl.stop();
    vi.restoreAllMocks();
    // Crystals draw via translate; grains and bokeh discs blit at absolute coords.
    const ys =
      rec.translates.length > 0
        ? rec.translates.map(([, y]) => y)
        : rec.drawImages.map((d) => d.args[2] as number);
    const perFrame = ys.length / 2;
    let sum = 0;
    for (let i = 0; i < perFrame; i++) sum += ys[perFrame + i] - ys[i];
    return { fall: sum / perFrame, rec };
  };

  it('falls with depth parallax — near crystals fall faster than far grains', () => {
    const near = meanFall(0.9).fall;
    const far = meanFall(0.3).fall;
    expect(near).toBeGreaterThan(0);
    expect(far).toBeGreaterThan(0);
    expect(near).toBeGreaterThan(far * 1.5);
  });

  it('has deep background layers that fall slower than the main field', () => {
    // 0.05 < deepLayerFraction → every flake lands in a deep layer (z < 0).
    const deep = meanFall(0.05).fall;
    const mainFar = meanFall(0.3).fall;
    expect(deep).toBeGreaterThan(0); // still falling, not frozen
    expect(deep).toBeLessThan(mainFar * 0.75); // …but slower than the main field's far edge
  });

  it('has a foreground bokeh layer — unrotated, big, and the fastest of all', () => {
    // 0.96 > 1 − bokeh.fraction → every flake is a foreground bokeh disc (z > 1).
    const { fall, rec } = meanFall(0.96);
    expect(rec.rotateCount).toBe(0); // out-of-focus discs never rotate
    expect(rec.translates.length).toBe(0); // …and blit plainly
    expect(rec.drawImages.length).toBeGreaterThan(0);
    // Drawn large: the depth extrapolation scales them past the main field's near edge.
    for (const d of rec.drawImages) expect(d.args[3] as number).toBeGreaterThan(28);
    // And near = fast: they leave the far grains well behind. (Not compared against the near
    // crystals: a pinned RNG puts the whole field at one position, so the curl field's vertical
    // term biases each pin by more than the bokeh-vs-near speed gap.)
    expect(fall).toBeGreaterThan(meanFall(0.3).fall * 1.5);
  });

  it('thickens, streaks and hazes the field when the scheduler raises a blizzard', () => {
    // Find the first full-strength storm in the deterministic schedule.
    let stormT = -1;
    for (let t = 130; t < 2000; t += 0.25) {
      if (blizzard(t) > 0.9) {
        stormT = t;
        break;
      }
    }
    expect(stormT).toBeGreaterThan(0);
    const rec = makeCtx();
    const ctrl = startPrecip(makeCanvas(rec), { kind: 'snow', reduced: false });
    let now = 0;
    pump(now); // dt = 0, primes lastTime
    pump((now += 50));
    // One calm frame's draw count (the reserve storm pool is dormant — neither stepped nor drawn).
    const calmMark = rec.drawImages.length;
    pump((now += 50));
    const calmFrame = rec.drawImages.length - calmMark;
    // Drive elapsed to the storm: each 50ms pump advances the (clamped) engine clock by 50ms.
    const frames = Math.ceil(stormT / 0.05) + 4;
    for (let i = 0; i < frames; i++) pump((now += 50));
    const stormMark = rec.drawImages.length;
    pump(now + 50);
    const stormDraws = rec.drawImages.slice(stormMark);
    // The storm pool has woken and the whiteout haze blits, so the frame draws far more…
    expect(stormDraws.length).toBeGreaterThan(calmFrame * 1.3);
    // …and wind-raked flakes elongate into motion streaks (height drawn well past width, which
    // never happens to the square-sprite flakes in calm air; the haze blit is wider than tall).
    expect(stormDraws.some((d) => (d.args[4] as number) > (d.args[3] as number) * 1.5)).toBe(true);
    ctrl.stop();
  });
});

/**
 * The lab weather override and the event pools (issue #455 follow-up). Forcing a mode ramps its
 * event to full strength over ~2.5s of engine time, so these drive a few seconds of 50ms-clamped
 * frames and compare per-frame draw activity between modes — no waiting for the natural epochs.
 */
describe('startPrecip forced snow weather (lab override)', () => {
  /** Pump `seconds` of engine time in 50ms-clamped frames, continuing from `from`. */
  const pumpSeconds = (from: number, seconds: number): number => {
    let now = from;
    for (let i = 0; i < Math.ceil(seconds / 0.05); i++) pump((now += 50));
    return now;
  };
  /** Draws recorded over exactly one further frame. */
  const frameDraws = (rec: ReturnType<typeof makeCtx>, now: number): number => {
    const mark = rec.drawImages.length;
    pump(now + 50);
    return rec.drawImages.length - mark;
  };

  it('ramps a forced blizzard in: the field visibly thickens without waiting for the scheduler', () => {
    const rec = makeCtx();
    const ctrl = startPrecip(makeCanvas(rec), { kind: 'snow', reduced: false, weather: 'calm' });
    pump(0);
    let now = pumpSeconds(0, 1);
    const calmFrame = frameDraws(rec, now);
    now += 50;
    ctrl.setWeather('blizzard');
    now = pumpSeconds(now, 4); // ramp is ~2.5s
    const stormFrame = frameDraws(rec, now);
    expect(stormFrame).toBeGreaterThan(calmFrame * 1.3); // storm pool + haze woke up
    ctrl.stop();
  });

  it('wakes the diamond-dust and graupel pools only under their events', () => {
    const rec = makeCtx();
    const ctrl = startPrecip(makeCanvas(rec), { kind: 'snow', reduced: false, weather: 'calm' });
    pump(0);
    let now = pumpSeconds(0, 1);
    const calmFrame = frameDraws(rec, now);
    now += 50;
    ctrl.setWeather('diamond-dust');
    now = pumpSeconds(now, 3.5);
    const dustFrame = frameDraws(rec, now);
    expect(dustFrame).toBeGreaterThan(calmFrame + 8); // the dust pool is drawing
    now += 50;
    ctrl.setWeather('graupel');
    now = pumpSeconds(now, 3.5); // the dust envelope eases out (~1.2s) while graupel eases in
    const graupelFrame = frameDraws(rec, now);
    expect(graupelFrame).toBeGreaterThan(calmFrame + 6); // …and now the pellet pool instead
    ctrl.stop();
  });

  it('flashes the whole canvas during forced thundersnow (and never in calm)', () => {
    const rec = makeCtx();
    const ctrl = startPrecip(makeCanvas(rec), { kind: 'snow', reduced: false, weather: 'calm' });
    pump(0);
    let now = pumpSeconds(0, 2);
    expect(rec.fillCount).toBe(0); // calm air: no lightning
    now += 50;
    ctrl.setWeather('thundersnow');
    pumpSeconds(now, 12); // the dense lab cadence flashes every few seconds
    expect(rec.fillCount).toBeGreaterThan(0);
    ctrl.stop();
  });

  it('spawns far-layer flakes across the deep ladder (five strata, all slower than the field)', () => {
    // Pin the RNG at 0.05: sample < deepLayerFraction, so every flake lands in the ladder (the
    // pinned pick lands on the first stratum) and draws with the fog-blended far sprite —
    // unrotated plain blits.
    vi.spyOn(Math, 'random').mockReturnValue(0.05);
    const rec = makeCtx();
    const ctrl = startPrecip(makeCanvas(rec), { kind: 'snow', reduced: false });
    pump(16);
    pump(32);
    ctrl.stop();
    vi.restoreAllMocks();
    expect(rec.rotateCount).toBe(0);
    expect(rec.translates.length).toBe(0);
    expect(rec.drawImages.length).toBeGreaterThan(0);
  });
});

describe('startPrecip wind-plaster (blizzard side accumulation)', () => {
  it('plasters storm-driven snow onto a windward face and composites it above the UI', () => {
    // A single 4px-wide "pillar" mid-screen: near-horizontal storm flight crossing its column
    // in the band just below its top edge hits the face; vertical top landings on a 4px column
    // are comparatively rare, so overlay activity here is dominated by the plaster path.
    const cols = 340;
    const tops = new Int16Array(cols).fill(NO_SURFACE);
    tops[170] = 400;
    const bots = new Int16Array(cols).fill(NO_SURFACE);
    const tracker: SurfaceTracker = {
      snapshot: () => ({ tops, bots, generation: 1 }),
      hoverFollow: () => null,
      stop: () => {},
    };
    const rec = makeCtx();
    const orec = makeCtx();
    const ctrl = startPrecip(makeCanvas(rec), {
      kind: 'snow',
      reduced: false,
      overlay: makeCanvas(orec),
      surfaces: () => tracker,
      weather: 'blizzard', // forced: ramps to full rake, driving flakes into the face (stick p→1)
    });
    let now = 0;
    pump(now);
    for (let i = 0; i < 240; i++) pump((now += 50)); // 12s of storm
    expect(orec.drawImages.length).toBeGreaterThan(0); // plaster rendered and composited
    ctrl.stop();
  });
});

describe('snow stick-chance seams (issue #455 follow-up)', () => {
  it('side sticking: a floor for a gentle brush, certainty at storm lean, stickier when warm', () => {
    expect(snowSideStickChance(0, 0)).toBeGreaterThan(0.05); // even a calm brush can take
    expect(snowSideStickChance(0, 0)).toBeLessThan(0.3); // …but usually brushes off
    expect(snowSideStickChance(2, 0)).toBe(1); // wind-pressed storm flight always plasters
    let prev = 0;
    for (let lean = 0; lean <= 2.5; lean += 0.25) {
      const p = snowSideStickChance(lean, 0);
      expect(p).toBeGreaterThanOrEqual(prev); // monotonic in press
      expect(p).toBeLessThanOrEqual(1);
      prev = p;
    }
    expect(snowSideStickChance(0.5, 1)).toBeGreaterThan(snowSideStickChance(0.5, 0)); // wet sticks
  });

  it('underside catching: small, warm-boosted, bounded', () => {
    const dry = snowUnderCatchChance(0);
    const wet = snowUnderCatchChance(1);
    expect(dry).toBeGreaterThan(0.02);
    expect(dry).toBeLessThan(0.25); // undersides collect far less than tops
    expect(wet).toBeGreaterThan(dry * 2); // wet snow clings under eaves
    expect(wet).toBeLessThanOrEqual(1);
  });

  it('catches emerging flakes on underside lips and composites the hanging fringe', () => {
    // A physically-impossible-but-isolating map: no tops at all (nothing can land or plaster),
    // only underside lips at y=300 — so any overlay compositing can come solely from the
    // underside-catch path. Warm snow is forced to lift the catch chance.
    const cols = 340;
    const tops = new Int16Array(cols).fill(NO_SURFACE);
    const bots = new Int16Array(cols).fill(300);
    const tracker: SurfaceTracker = {
      snapshot: () => ({ tops, bots, generation: 1 }),
      hoverFollow: () => null,
      stop: () => {},
    };
    const rec = makeCtx();
    const orec = makeCtx();
    const ctrl = startPrecip(makeCanvas(rec), {
      kind: 'snow',
      reduced: false,
      overlay: makeCanvas(orec),
      surfaces: () => tracker,
      weather: 'warm-snow',
    });
    let now = 0;
    pump(now);
    // The initial fill scatters flakes across the height; those above the lip line fall through
    // it and roll the catch chance — with ~a hundred near flakes crossing, some always catch.
    for (let i = 0; i < 300; i++) pump((now += 50)); // 15s
    expect(orec.drawImages.length).toBeGreaterThan(0); // the fringe rendered and composited
    ctrl.stop();
  });
});

describe('snow drift saturation (issue #437)', () => {
  it('caps each column at its own capacity, undulating rather than level', () => {
    const span = Array.from({ length: 300 }, (_, c) => snowMoundCapacity(c));
    const low = Math.min(...span);
    const high = Math.max(...span);
    expect(low).toBeGreaterThan(0); // every column can hold some snow
    // The whole point: a wide control does not share one flat ceiling across its width.
    expect(high - low).toBeGreaterThan(high * 0.25);
    // …but it is a drift shape, not per-column noise — the profile changes gradually.
    for (let c = 1; c < span.length; c++) {
      expect(Math.abs(span[c]! - span[c - 1]!)).toBeLessThan((high - low) / 4);
    }
    // Deterministic, so a map rebuild never reshuffles the crest under settled snow.
    expect(snowMoundCapacity(137)).toBe(span[137]);
  });

  it('sheds onto lower ground once a drift fills: certain when shallow, impossible when full', () => {
    const cap = 6;
    expect(snowSettleChance(0, cap)).toBe(1); // bare surface always takes
    expect(snowSettleChance(cap * 0.5, cap)).toBe(1); // still building
    expect(snowSettleChance(cap, cap)).toBe(0); // full — the flake falls on past
    expect(snowSettleChance(cap * 2, cap)).toBe(0); // and stays past, however over-full
    expect(snowSettleChance(1, 0)).toBe(0); // no capacity, nothing settles
    let prev = 1;
    for (let d = 0; d <= cap; d += cap / 40) {
      const p = snowSettleChance(d, cap);
      expect(p).toBeLessThanOrEqual(prev + 1e-9); // monotonically shedding
      expect(p).toBeGreaterThanOrEqual(0);
      prev = p;
    }
  });

  it('settles a drift whose crest rolls instead of levelling into a hard line', () => {
    // Deterministic field: a seeded PRNG stands in for Math.random so flakes spread across the
    // width (a pinned constant would stack them all in one column) and the run is reproducible.
    let seed = 0x9e3779b9;
    vi.spyOn(Math, 'random').mockImplementation(() => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    });
    // Capture the crest the mound layer actually paints. The test DOM gives a canvas no real 2D
    // context, so the offscreen mound cache gets a recording one — identified by its full-viewport
    // backing store, which no sprite canvas comes close to. `traceCrest` passes every column's
    // crest point as a quadratic control point, so the control-point ys *are* the drift profile.
    const crestYs: number[] = [];
    const moundCtx = new Proxy(
      {
        createLinearGradient: () => ({ addColorStop: () => {} }),
        quadraticCurveTo: (_cx: number, cy: number) => {
          crestYs.push(cy);
        },
      } as Record<string, unknown>,
      {
        get: (t, k) => (k in t ? t[k as string] : () => {}),
        set: (t, k, v) => {
          t[k as string] = v;
          return true;
        },
      },
    );
    const proto = Object.getPrototypeOf(document.createElement('canvas')) as HTMLCanvasElement;
    const realGetContext = proto.getContext;
    vi.spyOn(proto, 'getContext').mockImplementation(function (this: HTMLCanvasElement, ...args: unknown[]) {
      if (args[0] === '2d' && this.width >= 1000 && this.height >= 600) {
        return moundCtx as unknown as CanvasRenderingContext2D;
      }
      return (realGetContext as (...a: unknown[]) => unknown).apply(this, args);
    } as typeof proto.getContext);

    const TOP = 400; // the flat control top every column of this map reports
    const surfaces = makeSurfaces(TOP);
    const ctrl = startPrecip(makeCanvas(makeCtx()), {
      kind: 'snow',
      reduced: false,
      overlay: makeCanvas(makeCtx()),
      surfaces: surfaces.factory,
      weather: 'squall',
    });
    // Squall weather thickens the fall, and the pump runs long past saturation: with one shared
    // cap every column ends on the same y and the painted crest collapses to a flat line (that
    // is what this run produces if the capacity/shed pair is removed).
    for (let i = 1; i <= 24000; i++) pump(i * 50);
    ctrl.stop();

    // A settled crest sits *on* the control top. This map reports no bottom edges, so no hanging
    // under-fringe can be drawn, and the only other curve the layer paints is a wind-plaster
    // strip down a face — whose control point is *below* the top. Hence the filter.
    const crest = crestYs.filter((y) => y <= TOP);
    expect(crest.length).toBeGreaterThan(50);
    // Only the final render's profile matters — earlier ones are the drift still growing.
    const settled = crest.slice(-200);
    const high = Math.min(...settled);
    const low = Math.max(...settled);
    expect(TOP - high).toBeGreaterThan(2); // a real drift built up
    expect(low - high).toBeGreaterThan(1.5); // …and its top rolls rather than shelving flat
    // Roughly 1.9s of pure simulation on an idle machine, and the frame count is load-bearing
    // rather than padding: with the per-column capacity replaced by one shared cap — the bug
    // this guards — the run still passes at 12,000 frames and only fails at 24,000, because
    // a drift that has not yet saturated rolls whether or not anything caps it. So the cost
    // cannot be trimmed, and under Vitest's 5s default the test timed out whenever the machine
    // was busy. The budget below covers that contention; a genuine hang is nowhere near it.
  }, 30_000);
});
