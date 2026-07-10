/**
 * precip-engine — a GPU-composited particle system for the app-wide animated weather layer
 * (rain / snow). Framework-agnostic on purpose: {@link startPrecip} drives a single `<canvas>` and
 * returns a controller; the React wrapper
 * ({@link import('./BackgroundEffects').BackgroundEffects}) owns the element and its lifecycle.
 *
 * ## Look — a turbulent wind field, not a uniform drift
 *
 * Real falling rain and snow ride a gusting, swirling airflow; a constant lean or a single sine
 * sway reads as fake. Grounded in the standard real-time recipe (Perlin/curl-noise-driven particle
 * advection from the snow-scene and GPU-rain literature), every particle is advected through a live
 * wind field assembled in {@link ./flow-field} from cheap closed-form functions:
 *  - **Gusts** — a global wind ({@link gust}) eases the whole field one way, settles, then leans
 *    back the other. Rain slants with it; snow is pushed across the screen.
 *  - **Flurries** — an intensity envelope ({@link flurry}) makes the weather pick up in surges and
 *    calm between them (harder wind, longer streaks, a touch denser).
 *  - **Turbulence & vortices** — a divergence-free curl field ({@link curlField}) plus a handful of
 *    transient {@link Vortex} eddies swirl flakes into curls and loops instead of a tidy diagonal.
 *
 * ## Look — the particles themselves
 *
 * Each kind pre-renders a *small set* of particle sprites once (see {@link buildSprites}) and every
 * particle picks one at spawn, so the field isn't a wall of identical dots:
 *  - **Rain** streaks are a bright thin core under a soft wide halo with a rounded, brighter head
 *    (the glassy look of a real drop), in two thicknesses. They **rotate to follow their velocity
 *    and elongate in the wind**, and fall in **depth layers** — distant drops are smaller, fainter
 *    and markedly slower than the fast, close foreground, so the field reads with real parallax. Two
 *    extra {@link TUNING.rain.deepLayers} sit further back still for a hazy, distant backdrop.
 *  - **Snow** is a mix of soft round grains (distant) and six-armed ice crystals — a plain star and
 *    a branched dendrite (nearer) — each crystal **slowly rotating** with a faint twinkle, so close
 *    flakes read as real snowflakes rather than blurry discs.
 *
 * ## Performance — cheap, and composited entirely on the GPU
 *
 * The layer sits behind every screen, so it must be cheap and must never touch pixels on the CPU:
 *  - **Every frame is `drawImage` of a pre-rendered sprite.** The crystal/streak bitmaps are
 *    rasterised into offscreen canvases *once* (rebuilt only on a theme/colour or DPR change). Per
 *    frame we only blit a cached texture as a translated/rotated/scaled quad — the GPU-accelerated
 *    fast path in every modern browser. There is **no per-frame path building, filter, gradient or
 *    pixel work**, so all rasterisation and compositing happens on the GPU; the CPU only runs the
 *    tiny per-particle vector maths (a few hundred particles), which is negligible.
 *  - **Fixed particle pool, zero per-frame allocation.** Particles (and vortices) are created once
 *    (count scales with viewport area, hard-capped) and mutated in place; velocity is stashed on the
 *    particle so the draw pass reuses it. Recycling a particle reuses the same object.
 *  - **Delta-timed** so speed is frame-rate independent, with the step clamped so a background tab
 *    resuming after a long pause never "teleports" the field.
 *  - **Paused when the tab is hidden** (no wasted frames) and fully torn down on {@link stop}.
 *  - **DPR-capped** backing store so a 3× phone doesn't rasterise 9× the pixels.
 *
 * Colours come from the `--precip-rain` / `--precip-snow` design tokens (read live, so the layer is
 * theme-correct); {@link PrecipController.refresh} re-reads them + rebuilds the sprites when the
 * theme changes. The layer is decorative — the caller marks the canvas `aria-hidden` — so under a
 * reduced-motion preference the engine paints a single calm static frame and never starts the loop.
 */
import { gust, flurry, curlField } from './flow-field';

/** Which particle system the canvas runs. */
export type PrecipKind = 'rain' | 'snow';

/** Handle returned by {@link startPrecip} to control a running layer. */
export interface PrecipController {
  /** Re-read the theme colours and rebuild the sprites (call on a light/dark change). */
  refresh(): void;
  /** Stop the loop and detach every listener (idempotent). */
  stop(): void;
}

/** Options for {@link startPrecip}. */
export interface StartPrecipOptions {
  readonly kind: PrecipKind;
  /** When true (OS reduced-motion or the "Reduce effects" switch), paint one static frame only. */
  readonly reduced: boolean;
  /** Device-pixel-ratio cap for the backing store (default 2). */
  readonly dprCap?: number;
}

/** Per-kind tuning. `density` = viewport px² per particle (lower ⇒ denser), clamped to [min, max]. */
const TUNING = {
  rain: {
    density: 9500,
    min: 40,
    max: 240,
    /**
     * Vertical fall speed range (css px/s), lerped by depth (far = slow, near = fast). The range is
     * deliberately wide (near ≈ 3.7× the far speed) so the depth layers read as clearly different
     * fall speeds — the parallax cue. Critically, streak *length* is NOT tied to this speed (see
     * {@link windStretchGain} below), so a fast near-drop isn't drawn proportionally longer, which would
     * cancel the very speed difference we want to show. The two {@link deepLayers} sit *behind* this
     * range (depth < 0) and so fall slower still.
     */
    speed: [272, 1003] as const,
    /** Baseline wind lean as a fraction of fall speed, before gusts. */
    baseLean: 0.1,
    /** Extra lean a full gust adds (fraction of fall speed); flurries amplify it. */
    gustLean: 0.34,
    /** Curl-turbulence drift (css px/s) — rain is heavy, so only a light jitter. */
    turb: 26,
    /** How strongly rain feels the eddies (heavy drops cut mostly straight through). */
    vortexFactor: 0.25,
    /** Streak sprite variants (core width / length, css px) so drops aren't all identical. */
    variants: [
      { width: 1.2, len: 17 },
      { width: 1.7, len: 22 },
    ] as const,
    /**
     * Wind-driven streak elongation. A streak's base length comes from its depth {@link scale}
     * (near = longer), and the wind then stretches it by `1 + lean·gain` (clamped to `max`) as it
     * slants — so gusts visibly rake drops out, but the stretch is the *same* factor at every depth
     * and therefore never masks the depth→speed parallax. `lean` here is the horizontal fraction of
     * the drop's velocity (|vx| / vy), which is depth-independent.
     */
    windStretchGain: 1.8,
    windStretchMax: 2.2,
    /** Depth-driven draw scale and alpha ranges (far → near); far is smaller + fainter to recede. */
    scale: [0.5, 1.15] as const,
    alpha: [0.16, 0.62] as const,
    /**
     * Two extra depth layers sitting *further back* than the main field. Their depth params are
     * negative, so the shared speed/scale/alpha lerps extrapolate to slower, smaller and fainter
     * drops — a hazy, distant backdrop behind the main rain. A slice of the field
     * ({@link deepLayerFraction}) is placed in these layers, added *on top of* the main count so the
     * foreground isn't thinned; {@link deepLayerJitter} spreads each layer's depth a touch so its
     * drops don't fall in lockstep.
     */
    deepLayers: [-0.1, -0.2] as const,
    deepLayerFraction: 0.18,
    deepLayerJitter: 0.02,
  },
  snow: {
    density: 15000,
    min: 30,
    max: 150,
    speed: [34, 92] as const,
    /** Peak sideways wind a full gust imparts (css px/s), scaled by flurry + depth. */
    wind: 74,
    /** Curl-turbulence drift (css px/s) — snow is light, so it swirls freely. */
    turb: 40,
    /** Snow rides the eddies fully. */
    vortexFactor: 1,
    /** Cap on horizontal speed as a multiple of fall speed (never pure sideways flight). */
    maxDriftRatio: 2.4,
    /** Grain (soft disc) radius in css px, for the small distant flakes. */
    grainRadius: 3,
    /** Ice-crystal arm length in css px, for the larger near flakes. */
    crystalArm: 8,
    /** Below this depth a flake is a plain grain; at/above it, a rotating crystal. */
    grainMaxZ: 0.4,
    /** Crystal spin range (rad/s); the sign is the spin direction. */
    spin: [-0.7, 0.7] as const,
    /** Twinkle: shimmer speed (rad/s) and depth (fraction of alpha removed at the dimmest). */
    twinkleSpeed: 1.6,
    twinkleAmp: 0.14,
    scale: [0.4, 1.25] as const,
    alpha: [0.32, 0.9] as const,
  },
} as const;

/** Vortex-cell tuning: transient eddies that drift with the wind and are recycled off-screen. */
const VORTEX = {
  /** One eddy per this many viewport px², clamped. */
  density: 320_000,
  min: 1,
  max: 3,
  /** Eddy radius range (css px). */
  radius: [150, 340] as const,
  /** Peak tangential speed range (css px/s) at the eddy's mid-radius. */
  peak: [42, 96] as const,
  /** How fast an eddy sinks through the field (css px/s). */
  sink: 20,
  /** How far a full gust carries an eddy sideways (css px/s) — shared by rain and snow. */
  drift: 30,
} as const;

/** Fallbacks if the token can't be read (kept close to the dark-theme values). */
const FALLBACK_COLOR: Record<PrecipKind, string> = {
  rain: 'oklch(0.82 0.045 240)',
  snow: 'oklch(0.97 0.006 250)',
};

/** Largest delta-time step honoured per frame (s) — caps a resume-from-hidden jump. */
const MAX_STEP = 0.05;

interface Particle {
  x: number;
  y: number;
  /** Depth in [0, 1]: 0 = far (small/slow/faint), 1 = near (large/fast/opaque). */
  z: number;
  /** Velocity this frame (css px/s), stashed by the step pass for the draw pass to reuse. */
  vx: number;
  vy: number;
  /** Index into the kind's sprite set (which streak thickness / flake shape this particle is). */
  variant: number;
  /** Spin rate (rad/s) for a rotating crystal; 0 for grains/rain. */
  spin: number;
  /** Random phase for spin start + twinkle, so flakes are decorrelated. */
  phase: number;
}

/** A drifting eddy that adds a tangential swirl to nearby particles. */
interface Vortex {
  x: number;
  y: number;
  /** Radius (css px) and its square (precomputed for the distance test). */
  r: number;
  r2: number;
  /** Signed peak tangential speed (css px/s); the sign is the spin direction. */
  peak: number;
}

/** A pre-rendered particle bitmap plus its half-extent in css px (for centring the blit). */
interface Sprite {
  canvas: HTMLCanvasElement;
  halfW: number;
  halfH: number;
}

/** Snow sprite-set indices. Grains are angularly symmetric (no rotation); crystals rotate. */
const SNOW_GRAIN = 0;

/** Uniform random in [min, max). Positions/timings only — no security concern. */
function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** Linear interpolate. */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Clamp `v` into [min, max]. */
function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/** Resolve a CSS custom property on `<html>` to its computed value, with a fallback. */
function readToken(name: string, fallback: string): string {
  if (typeof getComputedStyle !== 'function') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/**
 * Wrap a CSS colour so it renders at a given alpha, without parsing it: `color-mix` blends it
 * toward `transparent`. Supported wherever the app runs (the token values are already `oklch`).
 */
function colorWithAlpha(color: string, alpha: number): string {
  return `color-mix(in oklab, ${color} ${Math.round(alpha * 100)}%, transparent)`;
}

/** Allocate a css-sized offscreen canvas with a DPR-scaled backing store, ready to draw into. */
function makeCanvas(
  cssW: number,
  cssH: number,
  dpr: number,
): [HTMLCanvasElement, CanvasRenderingContext2D | null] {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(cssW * dpr));
  c.height = Math.max(1, Math.round(cssH * dpr));
  const g = c.getContext('2d');
  if (g) g.scale(dpr, dpr);
  return [c, g];
}

/**
 * Build a rain-streak sprite for one thickness: a bright thin core over a soft wide halo, with a
 * rounded brighter head at the leading (bottom) tip. Drawn vertical; the engine rotates it to the
 * drop's velocity at draw time, so the wind slant is live rather than baked in.
 */
function buildRainStreak(dpr: number, color: string, width: number, len: number): HTMLCanvasElement {
  const headR = width * 1.4;
  const topPad = width * 1.6;
  const botPad = Math.max(width * 1.6, headR + 1);
  const halo = width * 2.4;
  const w = Math.ceil(halo + 2);
  const h = Math.ceil(len + topPad + botPad);
  const [c, g] = makeCanvas(w, h, dpr);
  if (g) {
    const cx = w / 2;
    const top = topPad;
    const bottom = topPad + len;
    g.lineCap = 'round';
    // Soft wide halo — the drop's glassy blur.
    const gh = g.createLinearGradient(cx, top, cx, bottom);
    gh.addColorStop(0, 'transparent');
    gh.addColorStop(0.4, colorWithAlpha(color, 0.1));
    gh.addColorStop(1, colorWithAlpha(color, 0.22));
    g.strokeStyle = gh;
    g.lineWidth = halo;
    g.beginPath();
    g.moveTo(cx, top);
    g.lineTo(cx, bottom);
    g.stroke();
    // Bright thin core.
    const gc = g.createLinearGradient(cx, top, cx, bottom);
    gc.addColorStop(0, 'transparent');
    gc.addColorStop(0.3, colorWithAlpha(color, 0.4));
    gc.addColorStop(1, color);
    g.strokeStyle = gc;
    g.lineWidth = width;
    g.beginPath();
    g.moveTo(cx, top);
    g.lineTo(cx, bottom);
    g.stroke();
    // Rounded, brighter head at the leading tip.
    const gr = g.createRadialGradient(cx, bottom, 0, cx, bottom, headR);
    gr.addColorStop(0, color);
    gr.addColorStop(0.5, colorWithAlpha(color, 0.6));
    gr.addColorStop(1, 'transparent');
    g.fillStyle = gr;
    g.beginPath();
    g.arc(cx, bottom, headR, 0, Math.PI * 2);
    g.fill();
  }
  return c;
}

/** Build the soft snow-grain sprite: a radial gradient disc that fades to transparent. */
function buildSnowGrain(dpr: number, color: string): HTMLCanvasElement {
  const r = TUNING.snow.grainRadius;
  const size = Math.ceil(r * 4);
  const [c, g] = makeCanvas(size, size, dpr);
  if (g) {
    const cx = size / 2;
    const grad = g.createRadialGradient(cx, cx, 0, cx, cx, r * 1.8);
    grad.addColorStop(0, color);
    grad.addColorStop(0.5, colorWithAlpha(color, 0.55));
    grad.addColorStop(1, 'transparent');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(cx, cx, r * 1.8, 0, Math.PI * 2);
    g.fill();
  }
  return c;
}

/**
 * Build a six-armed ice-crystal sprite. `dendrite` adds side-branches to each arm (a fuller
 * snowflake); otherwise it's a plain six-point star. A faint central glow and bright core dot give
 * it body. Drawn small and soft so at background scale it reads as a delicate flake, not an icon.
 */
function buildSnowCrystal(dpr: number, color: string, dendrite: boolean): HTMLCanvasElement {
  const arm = TUNING.snow.crystalArm;
  const pad = 2;
  const size = Math.ceil(arm * 2 + pad * 2);
  const [c, g] = makeCanvas(size, size, dpr);
  if (g) {
    const cx = size / 2;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    // Faint central glow.
    const glow = g.createRadialGradient(cx, cx, 0, cx, cx, arm * 0.55);
    glow.addColorStop(0, colorWithAlpha(color, 0.5));
    glow.addColorStop(1, 'transparent');
    g.fillStyle = glow;
    g.beginPath();
    g.arc(cx, cx, arm * 0.55, 0, Math.PI * 2);
    g.fill();
    // Six arms, fading from bright at the hub to faint at the tips.
    for (let i = 0; i < 6; i++) {
      const a = (i * Math.PI) / 3;
      const ex = cx + Math.cos(a) * arm;
      const ey = cx + Math.sin(a) * arm;
      const ga = g.createLinearGradient(cx, cx, ex, ey);
      ga.addColorStop(0, colorWithAlpha(color, 0.85));
      ga.addColorStop(1, colorWithAlpha(color, 0.1));
      g.strokeStyle = ga;
      g.lineWidth = 1.1;
      g.beginPath();
      g.moveTo(cx, cx);
      g.lineTo(ex, ey);
      g.stroke();
      if (dendrite) {
        g.strokeStyle = colorWithAlpha(color, 0.5);
        g.lineWidth = 0.9;
        for (const f of [0.5, 0.72]) {
          const bx = cx + Math.cos(a) * arm * f;
          const by = cx + Math.sin(a) * arm * f;
          const blen = arm * (f === 0.5 ? 0.34 : 0.22);
          for (const s of [-1, 1]) {
            const ba = a + (s * Math.PI) / 3;
            g.beginPath();
            g.moveTo(bx, by);
            g.lineTo(bx + Math.cos(ba) * blen, by + Math.sin(ba) * blen);
            g.stroke();
          }
        }
      }
    }
    // Bright core dot.
    g.fillStyle = color;
    g.beginPath();
    g.arc(cx, cx, 1.1, 0, Math.PI * 2);
    g.fill();
  }
  return c;
}

export function startPrecip(canvas: HTMLCanvasElement, opts: StartPrecipOptions): PrecipController {
  const { kind, reduced } = opts;
  const dprCap = opts.dprCap ?? 2;
  const ctx = canvas.getContext('2d');
  // No 2D context (very old browser or a jsdom test): nothing to do — a no-op controller keeps the
  // caller's lifecycle simple and the app fully functional without the decoration.
  if (!ctx) return { refresh: () => {}, stop: () => {} };

  let dpr = 1;
  let cssWidth = 0;
  let cssHeight = 0;
  let sprites: Sprite[] = [];
  /** Largest sprite half-height across the set (for the off-screen margin + recycle test). */
  let spriteMaxHalfH = 0;
  let particles: Particle[] = [];
  let vortices: Vortex[] = [];
  let rafId = 0;
  let lastTime = 0;
  let resizeQueued = false;
  let stopped = false;
  let elapsed = 0;
  // Wind context for the current frame — computed once per frame, read by every particle.
  let frameGust = 0;
  let frameFlurry = 0;
  /** How far off each edge a particle travels before it wraps/recycles (kept fully off-screen). */
  let edgeMargin = 0;

  function toSprite(c: HTMLCanvasElement): Sprite {
    return { canvas: c, halfW: c.width / dpr / 2, halfH: c.height / dpr / 2 };
  }

  function buildSprites(): void {
    const color = readToken(kind === 'rain' ? '--precip-rain' : '--precip-snow', FALLBACK_COLOR[kind]);
    if (kind === 'rain') {
      sprites = TUNING.rain.variants.map((v) => toSprite(buildRainStreak(dpr, color, v.width, v.len)));
    } else {
      sprites = [
        toSprite(buildSnowGrain(dpr, color)),
        toSprite(buildSnowCrystal(dpr, color, false)),
        toSprite(buildSnowCrystal(dpr, color, true)),
      ];
    }
    spriteMaxHalfH = sprites.reduce((m, s) => Math.max(m, s.halfH), 0);
    // Streaks stretch (up to windStretchMax) and every sprite scales up with depth, so the margin
    // uses the largest drawn half-height to keep a particle fully off-screen before it wraps.
    const maxStretch = kind === 'rain' ? TUNING.rain.windStretchMax : 1;
    edgeMargin = spriteMaxHalfH * 2 * TUNING[kind].scale[1] * maxStretch + 8;
  }

  function spawn(p: Particle, initial: boolean): void {
    p.z = Math.random();
    p.vx = 0;
    p.vy = 0;
    p.phase = rand(0, Math.PI * 2);
    if (kind === 'snow') {
      if (p.z < TUNING.snow.grainMaxZ) {
        p.variant = SNOW_GRAIN;
        p.spin = 0;
      } else {
        p.variant = Math.random() < 0.5 ? 1 : 2; // plain star or branched dendrite
        p.spin = rand(TUNING.snow.spin[0], TUNING.snow.spin[1]);
      }
    } else {
      p.variant = Math.random() < 0.5 ? 0 : 1; // streak thickness
      p.spin = 0;
      // A slice of the field belongs to the two deep-background layers (depth < 0): pick one and
      // jitter its depth so its drops don't move in lockstep. The rest keep the main-field depth.
      const rt = TUNING.rain;
      if (Math.random() < rt.deepLayerFraction) {
        const layer = rt.deepLayers[Math.random() < 0.5 ? 0 : 1];
        p.z = layer + rand(-rt.deepLayerJitter, rt.deepLayerJitter);
      }
    }
    p.x = rand(-edgeMargin, cssWidth + edgeMargin);
    // On (re)spawn a particle starts just above the top; on the very first fill it is scattered
    // across the height so the field is already full at t=0 rather than raining in from nothing.
    p.y = initial ? rand(0, cssHeight) : -rand(spriteMaxHalfH, spriteMaxHalfH + cssHeight * 0.2);
  }

  function spawnVortex(v: Vortex, initial: boolean): void {
    v.r = rand(VORTEX.radius[0], VORTEX.radius[1]);
    v.r2 = v.r * v.r;
    const sign = Math.random() < 0.5 ? -1 : 1;
    v.peak = sign * rand(VORTEX.peak[0], VORTEX.peak[1]);
    v.x = rand(0, cssWidth);
    v.y = initial ? rand(0, cssHeight) : -rand(v.r * 0.5, v.r);
  }

  function resize(): void {
    const targetDpr = Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, dprCap);
    cssWidth = canvas.clientWidth || (typeof innerWidth === 'number' ? innerWidth : 0);
    cssHeight = canvas.clientHeight || (typeof innerHeight === 'number' ? innerHeight : 0);
    dpr = targetDpr;
    canvas.width = Math.max(1, Math.round(cssWidth * dpr));
    canvas.height = Math.max(1, Math.round(cssHeight * dpr));
    // Draw in CSS pixels; the backing store is the DPR-scaled size.
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    buildSprites();

    const t = TUNING[kind];
    const area = Math.max(1, cssWidth * cssHeight);
    const base = Math.round(clamp(area / t.density, t.min, t.max));
    // Rain adds the deep-background layers on top of the main count, so `deepLayerFraction` of the
    // total lands in them (via spawn) without thinning the main field.
    const frac = kind === 'rain' ? TUNING.rain.deepLayerFraction : 0;
    const count = base + Math.round((base * frac) / (1 - frac));
    if (particles.length !== count) {
      particles = Array.from({ length: count }, () => ({
        x: 0,
        y: 0,
        z: 0,
        vx: 0,
        vy: 0,
        variant: 0,
        spin: 0,
        phase: 0,
      }));
      for (const p of particles) spawn(p, true);
    }

    const vCount = Math.round(clamp(area / VORTEX.density, VORTEX.min, VORTEX.max));
    if (vortices.length !== vCount) {
      vortices = Array.from({ length: vCount }, () => ({ x: 0, y: 0, r: 0, r2: 0, peak: 0 }));
      for (const v of vortices) spawnVortex(v, true);
    }
  }

  /** Add every eddy's tangential swirl to the particle's already-set velocity. */
  function addVortices(p: Particle, factor: number): void {
    for (const v of vortices) {
      const dx = p.x - v.x;
      const dy = p.y - v.y;
      const r2 = dx * dx + dy * dy;
      if (r2 >= v.r2) continue;
      const r = Math.sqrt(r2);
      if (r < 0.01) continue;
      // Rankine-like profile: zero at the centre and the rim, peaking at the mid-radius — no
      // singularity, so a particle passing through the core stays well-behaved.
      const norm = r / v.r;
      const bump = 4 * norm * (1 - norm);
      const vt = v.peak * bump * factor;
      p.vx += (-dy / r) * vt;
      p.vy += (dx / r) * vt;
    }
  }

  function advanceVortices(dt: number): void {
    for (const v of vortices) {
      // Eddies are carried along by the wind and sink slowly, then recycle off the bottom.
      v.x += frameGust * VORTEX.drift * dt;
      v.y += VORTEX.sink * dt;
      if (v.x < -v.r) v.x += cssWidth + 2 * v.r;
      else if (v.x > cssWidth + v.r) v.x -= cssWidth + 2 * v.r;
      if (v.y - v.r > cssHeight) spawnVortex(v, false);
    }
  }

  function stepRain(p: Particle, dt: number): void {
    const t = TUNING.rain;
    const fall = lerp(t.speed[0], t.speed[1], p.z);
    const lean = t.baseLean + frameGust * t.gustLean * (0.6 + frameFlurry * 0.7);
    const c = curlField(p.x, p.y, elapsed);
    p.vx = fall * lean + c.x * t.turb * p.z;
    p.vy = fall;
    addVortices(p, t.vortexFactor);
    p.x += p.vx * dt;
    p.y += p.vy * dt;
  }

  function stepSnow(p: Particle, dt: number): void {
    const t = TUNING.snow;
    const fall = lerp(t.speed[0], t.speed[1], p.z);
    const depth = 0.45 + p.z; // nearer flakes catch more wind
    const c = curlField(p.x, p.y, elapsed);
    p.vx = frameGust * t.wind * (0.5 + frameFlurry) * depth + c.x * t.turb * depth;
    p.vy = fall + c.y * t.turb * 0.5 * depth;
    addVortices(p, t.vortexFactor);
    // Never let a flake fly purely sideways, however hard the gust/eddy pushes.
    p.vx = clamp(p.vx, -fall * t.maxDriftRatio, fall * t.maxDriftRatio);
    p.x += p.vx * dt;
    p.y += p.vy * dt;
  }

  /** Wrap the particle horizontally (wind blows either way) and recycle it once past the bottom. */
  function wrapAndRecycle(p: Particle): void {
    if (p.x < -edgeMargin) p.x += cssWidth + 2 * edgeMargin;
    else if (p.x > cssWidth + edgeMargin) p.x -= cssWidth + 2 * edgeMargin;
    if (p.y - spriteMaxHalfH > cssHeight) spawn(p, false);
  }

  function drawRain(p: Particle): void {
    const s = sprites[p.variant];
    if (!s) return;
    const t = TUNING.rain;
    const scale = lerp(t.scale[0], t.scale[1], p.z);
    // Base length is depth-scaled (near = longer); the wind then elongates it by the drop's lean
    // (|vx| / vy) — a depth-independent factor, so it never cancels the depth→speed parallax. p.vy
    // is the pure fall speed for rain (no vertical turbulence is added), so it's the lean baseline.
    const lean = p.vy > 0 ? Math.abs(p.vx) / p.vy : 0;
    const stretch = clamp(1 + lean * t.windStretchGain, 1, t.windStretchMax);
    const w = s.halfW * 2 * scale;
    const h = s.halfH * 2 * scale * stretch;
    // Rotate the vertical sprite so its downward axis aligns with the drop's velocity.
    const angle = Math.atan2(-p.vx, p.vy);
    ctx!.save();
    ctx!.translate(p.x, p.y);
    ctx!.rotate(angle);
    ctx!.globalAlpha = lerp(t.alpha[0], t.alpha[1], p.z);
    ctx!.drawImage(s.canvas, -w / 2, -h / 2, w, h);
    ctx!.restore();
  }

  function drawSnow(p: Particle): void {
    const s = sprites[p.variant];
    if (!s) return;
    const t = TUNING.snow;
    const scale = lerp(t.scale[0], t.scale[1], p.z);
    const w = s.halfW * 2 * scale;
    const h = s.halfH * 2 * scale;
    // A flurry lifts the whole field's opacity a touch (surges read as "thicker"); a faint per-flake
    // twinkle keeps close crystals from looking static.
    const twinkle = 1 - t.twinkleAmp * (0.5 + 0.5 * Math.sin(elapsed * t.twinkleSpeed + p.phase));
    const alpha = lerp(t.alpha[0], t.alpha[1], p.z) * (0.85 + frameFlurry * 0.15) * twinkle;
    ctx!.globalAlpha = alpha > 1 ? 1 : alpha;
    if (p.variant === SNOW_GRAIN) {
      // Grains are angularly symmetric — a plain blit, the cheapest path.
      ctx!.drawImage(s.canvas, p.x - w / 2, p.y - h / 2, w, h);
      return;
    }
    // Crystals rotate slowly around their centre.
    ctx!.save();
    ctx!.translate(p.x, p.y);
    ctx!.rotate(elapsed * p.spin + p.phase);
    ctx!.drawImage(s.canvas, -w / 2, -h / 2, w, h);
    ctx!.restore();
  }

  function paint(animate: boolean, dt: number): void {
    ctx!.clearRect(0, 0, cssWidth, cssHeight);
    if (animate) {
      frameGust = gust(elapsed);
      frameFlurry = flurry(elapsed);
      advanceVortices(dt);
    }
    if (kind === 'rain') {
      for (const p of particles) {
        if (animate) {
          stepRain(p, dt);
          wrapAndRecycle(p);
        }
        drawRain(p);
      }
    } else {
      for (const p of particles) {
        if (animate) {
          stepSnow(p, dt);
          wrapAndRecycle(p);
        }
        drawSnow(p);
      }
    }
    ctx!.globalAlpha = 1;
  }

  function frame(now: number): void {
    if (stopped) return;
    const dt = lastTime ? Math.min((now - lastTime) / 1000, MAX_STEP) : 0;
    lastTime = now;
    elapsed += dt;
    paint(true, dt);
    rafId = requestAnimationFrame(frame);
  }

  function loop(): void {
    if (stopped || reduced) return;
    cancelAnimationFrame(rafId);
    lastTime = 0;
    rafId = requestAnimationFrame(frame);
  }

  function onVisibility(): void {
    if (reduced) return;
    if (document.hidden) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    } else if (!rafId) {
      loop();
    }
  }

  function onResize(): void {
    if (resizeQueued || stopped) return;
    resizeQueued = true;
    requestAnimationFrame(() => {
      resizeQueued = false;
      if (stopped) return;
      resize();
      if (reduced) paint(false, 0);
    });
  }

  // ── Start ────────────────────────────────────────────────────────────────────────────────
  resize();
  if (reduced) {
    // Reduced motion: one calm static frame, no loop (a canvas isn't reached by the CSS
    // reduced-motion catch-all, so the gate is enforced here).
    paint(false, 0);
  } else {
    loop();
    document.addEventListener('visibilitychange', onVisibility);
  }
  addEventListener('resize', onResize);

  return {
    refresh() {
      if (stopped) return;
      buildSprites();
      if (reduced) paint(false, 0);
    },
    stop() {
      stopped = true;
      cancelAnimationFrame(rafId);
      removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
