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
 * Rain streaks additionally **rotate to follow their velocity and stretch with speed** (the
 * motion-blur look of a real drop), so a gust visibly rakes them sideways.
 *
 * ## Performance — cheap, and composited entirely on the GPU
 *
 * The layer sits behind every screen, so it must be cheap and must never touch pixels on the CPU:
 *  - **Every frame is `drawImage` of a pre-rendered sprite.** Each kind rasterises *one* particle
 *    bitmap (a soft rain streak / a soft snow disc) into an offscreen canvas once. Per frame we only
 *    blit that cached texture as a translated/rotated/scaled quad — the GPU-accelerated fast path in
 *    every modern browser. There is **no per-frame path building, filter, gradient or pixel work**,
 *    so all rasterisation and compositing happens on the GPU; the CPU only runs the tiny per-particle
 *    vector maths (a few hundred particles), which is negligible.
 *  - **Fixed particle pool, zero per-frame allocation.** Particles (and vortices) are created once
 *    (count scales with viewport area, hard-capped) and mutated in place; velocity is stashed on the
 *    particle so the draw pass reuses it. Recycling a particle reuses the same object.
 *  - **Delta-timed** so speed is frame-rate independent, with the step clamped so a background tab
 *    resuming after a long pause never "teleports" the field.
 *  - **Paused when the tab is hidden** (no wasted frames) and fully torn down on {@link stop}.
 *  - **DPR-capped** backing store so a 3× phone doesn't rasterise 9× the pixels.
 *
 * Colours come from the `--precip-rain` / `--precip-snow` design tokens (read live, so the layer is
 * theme-correct); {@link PrecipController.refresh} re-reads them + rebuilds the sprite when the
 * theme changes. The layer is decorative — the caller marks the canvas `aria-hidden` — so under a
 * reduced-motion preference the engine paints a single calm static frame and never starts the loop.
 */
import { gust, flurry, curlField } from './flow-field';

/** Which particle system the canvas runs. */
export type PrecipKind = 'rain' | 'snow';

/** Handle returned by {@link startPrecip} to control a running layer. */
export interface PrecipController {
  /** Re-read the theme colours and rebuild the sprite (call on a light/dark change). */
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
    /** Vertical fall speed range (css px/s), lerped by depth (near = faster). */
    speed: [520, 1080] as const,
    /** Baseline wind lean as a fraction of fall speed, before gusts. */
    baseLean: 0.1,
    /** Extra lean a full gust adds (fraction of fall speed); flurries amplify it. */
    gustLean: 0.34,
    /** Curl-turbulence drift (css px/s) — rain is heavy, so only a light jitter. */
    turb: 26,
    /** How strongly rain feels the eddies (heavy drops cut mostly straight through). */
    vortexFactor: 0.25,
    /** Reference streak length / width (css px) before the per-particle depth scale. */
    refLen: 20,
    refWidth: 1.5,
    /** Speed (css px/s) at which a streak draws at its natural length; faster ⇒ stretched. */
    refSpeed: 780,
    /** Streak length multiplier bounds vs {@link refSpeed}. */
    stretch: [0.8, 2.2] as const,
    /** Depth-driven draw scale and alpha ranges (far → near). */
    scale: [0.55, 1.15] as const,
    alpha: [0.2, 0.62] as const,
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
    /** Reference flake radius (css px) before the per-particle depth scale. */
    refRadius: 3.2,
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
 * Build the rain-streak sprite: a soft vertical line, transparent at the trailing (top) end and
 * brightest at the leading (bottom) tip. Drawn vertical; the engine rotates it to the drop's
 * velocity at draw time, so the wind slant is live rather than baked in.
 */
function buildRainSprite(dpr: number, color: string): HTMLCanvasElement {
  const t = TUNING.rain;
  const pad = t.refWidth; // room for the round cap so the tip isn't clipped
  const w = Math.ceil(t.refWidth + pad * 2);
  const h = Math.ceil(t.refLen + pad * 2);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * dpr));
  c.height = Math.max(1, Math.round(h * dpr));
  const g = c.getContext('2d');
  if (g) {
    g.scale(dpr, dpr);
    const cx = w / 2;
    const top = pad;
    const bottom = pad + t.refLen;
    const grad = g.createLinearGradient(cx, top, cx, bottom);
    grad.addColorStop(0, 'transparent');
    grad.addColorStop(0.35, colorWithAlpha(color, 0.35));
    grad.addColorStop(1, color);
    g.strokeStyle = grad;
    g.lineWidth = t.refWidth;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(cx, top);
    g.lineTo(cx, bottom);
    g.stroke();
  }
  return c;
}

/** Build the soft snow-flake sprite: a radial gradient disc that fades to transparent. */
function buildSnowSprite(dpr: number, color: string): HTMLCanvasElement {
  const r = TUNING.snow.refRadius;
  const size = Math.ceil(r * 4);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(size * dpr));
  c.height = Math.max(1, Math.round(size * dpr));
  const g = c.getContext('2d');
  if (g) {
    g.scale(dpr, dpr);
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
 * Wrap a CSS colour so it renders at a given alpha, without parsing it: `color-mix` blends it
 * toward `transparent`. Supported wherever the app runs (the token values are already `oklch`).
 */
function colorWithAlpha(color: string, alpha: number): string {
  return `color-mix(in oklab, ${color} ${Math.round(alpha * 100)}%, transparent)`;
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
  let sprite: HTMLCanvasElement | null = null;
  let spriteHalfW = 0;
  let spriteHalfH = 0;
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

  function buildSprite(): void {
    const color = readToken(kind === 'rain' ? '--precip-rain' : '--precip-snow', FALLBACK_COLOR[kind]);
    sprite = kind === 'rain' ? buildRainSprite(dpr, color) : buildSnowSprite(dpr, color);
    // Draw-time offsets so a particle's (x, y) is its centre.
    spriteHalfW = sprite.width / dpr / 2;
    spriteHalfH = sprite.height / dpr / 2;
    // The rain streak stretches (up to stretch[1]) and every sprite scales up with depth, so the
    // margin uses the largest drawn half-height to keep a particle fully off-screen before it wraps.
    const t = TUNING[kind];
    const maxStretch = kind === 'rain' ? TUNING.rain.stretch[1] : 1;
    edgeMargin = spriteHalfH * 2 * t.scale[1] * maxStretch + 8;
  }

  function spawn(p: Particle, initial: boolean): void {
    p.z = Math.random();
    p.vx = 0;
    p.vy = 0;
    p.x = rand(-edgeMargin, cssWidth + edgeMargin);
    // On (re)spawn a particle starts just above the top; on the very first fill it is scattered
    // across the height so the field is already full at t=0 rather than raining in from nothing.
    p.y = initial ? rand(0, cssHeight) : -rand(spriteHalfH, spriteHalfH + cssHeight * 0.2);
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
    buildSprite();

    const t = TUNING[kind];
    const area = Math.max(1, cssWidth * cssHeight);
    const count = Math.round(clamp(area / t.density, t.min, t.max));
    if (particles.length !== count) {
      particles = Array.from({ length: count }, () => ({ x: 0, y: 0, z: 0, vx: 0, vy: 0 }));
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
    if (p.y - spriteHalfH > cssHeight) spawn(p, false);
  }

  function drawRain(p: Particle): void {
    if (!sprite) return;
    const t = TUNING.rain;
    const scale = lerp(t.scale[0], t.scale[1], p.z);
    const speed = Math.hypot(p.vx, p.vy);
    const stretch = speed <= 0 ? t.stretch[0] : clamp(speed / t.refSpeed, t.stretch[0], t.stretch[1]);
    const w = spriteHalfW * 2 * scale;
    const h = spriteHalfH * 2 * scale * stretch;
    // Rotate the vertical sprite so its downward axis aligns with the drop's velocity.
    const angle = Math.atan2(-p.vx, p.vy);
    ctx!.save();
    ctx!.translate(p.x, p.y);
    ctx!.rotate(angle);
    ctx!.globalAlpha = lerp(t.alpha[0], t.alpha[1], p.z);
    ctx!.drawImage(sprite, -w / 2, -h / 2, w, h);
    ctx!.restore();
  }

  function drawSnow(p: Particle): void {
    if (!sprite) return;
    const t = TUNING.snow;
    const scale = lerp(t.scale[0], t.scale[1], p.z);
    const w = spriteHalfW * 2 * scale;
    const h = spriteHalfH * 2 * scale;
    // A flurry lifts the whole field's opacity a touch, so surges read as "thicker" snow.
    const alpha = lerp(t.alpha[0], t.alpha[1], p.z) * (0.85 + frameFlurry * 0.15);
    ctx!.globalAlpha = alpha > 1 ? 1 : alpha;
    ctx!.drawImage(sprite, p.x - w / 2, p.y - h / 2, w, h);
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
      buildSprite();
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
