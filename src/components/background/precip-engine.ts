/**
 * precip-engine — a tiny, GPU-friendly particle system for the app-wide animated background
 * weather layer (rain / snow). Framework-agnostic on purpose: {@link startPrecip} drives a single
 * `<canvas>` and returns a controller; the React wrapper
 * ({@link import('./BackgroundEffects').BackgroundEffects}) owns the element and its lifecycle.
 *
 * Performance is the whole point — the effect sits behind every screen, so it must be cheap:
 *  - **Pre-rendered sprite, reused every frame.** Each kind rasterises *one* particle bitmap
 *    (a leaning rain streak / a soft snow disc) into an offscreen canvas at start; every frame is
 *    a `drawImage` of that cached bitmap (the GPU-composited fast path in every modern browser),
 *    never per-frame path building. Depth is a uniform `drawImage` scale + `globalAlpha`, so one
 *    sprite covers the whole parallax range.
 *  - **Fixed particle pool, zero per-frame allocation.** Particles are created once (count scales
 *    with viewport area, hard-capped) and mutated in place; recycling a particle to the top reuses
 *    the same object. Per-particle randomness (depth, sway phase) is precomputed at spawn.
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
    /** Wind lean as a fraction of vertical speed (also the sprite's slant). */
    windTan: 0.26,
    /** Reference streak length / width (css px) before the per-particle depth scale. */
    refLen: 20,
    refWidth: 1.5,
    /** Depth-driven draw scale and alpha ranges (far → near). */
    scale: [0.55, 1.15] as const,
    alpha: [0.2, 0.62] as const,
  },
  snow: {
    density: 15000,
    min: 30,
    max: 150,
    speed: [34, 92] as const,
    /** Reference flake radius (css px) before the per-particle depth scale. */
    refRadius: 3.2,
    scale: [0.4, 1.25] as const,
    alpha: [0.32, 0.9] as const,
    /** Horizontal sway amplitude (css px) and angular speed (rad/s) ranges. */
    swayAmp: [8, 26] as const,
    swaySpeed: [0.5, 1.4] as const,
  },
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
  /** Sway phase (snow only); unused for rain. */
  phase: number;
}

/** Uniform random in [min, max). Positions/timings only — no security concern. */
function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** Linear interpolate. */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Resolve a CSS custom property on `<html>` to its computed value, with a fallback. */
function readToken(name: string, fallback: string): string {
  if (typeof getComputedStyle !== 'function') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/** Build the leaning rain-streak sprite: a slanted gradient line, brightest at the leading tip. */
function buildRainSprite(dpr: number, color: string): HTMLCanvasElement {
  const t = TUNING.rain;
  const dx = t.refLen * t.windTan;
  const w = Math.ceil(dx + t.refWidth);
  const h = Math.ceil(t.refLen + t.refWidth);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * dpr));
  c.height = Math.max(1, Math.round(h * dpr));
  const g = c.getContext('2d');
  if (g) {
    g.scale(dpr, dpr);
    const x0 = t.refWidth / 2;
    const y0 = t.refWidth / 2;
    const grad = g.createLinearGradient(x0, y0, x0 + dx, y0 + t.refLen);
    grad.addColorStop(0, 'transparent');
    grad.addColorStop(0.35, colorWithAlpha(color, 0.35));
    grad.addColorStop(1, color);
    g.strokeStyle = grad;
    g.lineWidth = t.refWidth;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo(x0 + dx, y0 + t.refLen);
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
  let rafId = 0;
  let lastTime = 0;
  let resizeQueued = false;
  let stopped = false;
  let elapsed = 0;

  function buildSprite(): void {
    const color = readToken(kind === 'rain' ? '--precip-rain' : '--precip-snow', FALLBACK_COLOR[kind]);
    sprite = kind === 'rain' ? buildRainSprite(dpr, color) : buildSnowSprite(dpr, color);
    // Draw-time offsets so a particle's (x, y) is its centre.
    spriteHalfW = sprite.width / dpr / 2;
    spriteHalfH = sprite.height / dpr / 2;
  }

  function spawn(p: Particle, initial: boolean): void {
    p.z = Math.random();
    p.phase = rand(0, Math.PI * 2);
    p.x = rand(-spriteHalfW, cssWidth + spriteHalfW);
    // On (re)spawn a particle starts just above the top; on the very first fill it is scattered
    // across the height so the field is already full at t=0 rather than raining in from nothing.
    p.y = initial ? rand(0, cssHeight) : -rand(spriteHalfH, spriteHalfH + cssHeight * 0.2);
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
    const count = Math.round(Math.min(Math.max(area / t.density, t.min), t.max));
    if (particles.length !== count) {
      particles = Array.from({ length: count }, () => ({ x: 0, y: 0, z: 0, phase: 0 }));
      for (const p of particles) spawn(p, true);
    }
  }

  function drawParticle(p: Particle): void {
    if (!sprite) return;
    const t = TUNING[kind];
    const scale = lerp(t.scale[0], t.scale[1], p.z);
    const w = spriteHalfW * 2 * scale;
    const h = spriteHalfH * 2 * scale;
    let x = p.x;
    if (kind === 'snow') {
      const amp = lerp(TUNING.snow.swayAmp[0], TUNING.snow.swayAmp[1], p.z);
      const speed = lerp(TUNING.snow.swaySpeed[0], TUNING.snow.swaySpeed[1], p.z);
      x += Math.sin(elapsed * speed + p.phase) * amp;
    }
    ctx!.globalAlpha = lerp(t.alpha[0], t.alpha[1], p.z);
    ctx!.drawImage(sprite, x - w / 2, p.y - h / 2, w, h);
  }

  function step(p: Particle, dt: number): void {
    const t = TUNING[kind];
    const speed = lerp(t.speed[0], t.speed[1], p.z);
    p.y += speed * dt;
    if (kind === 'rain') p.x += speed * TUNING.rain.windTan * dt;
    if (p.y - spriteHalfH > cssHeight || p.x - spriteHalfW > cssWidth + spriteHalfW) spawn(p, false);
  }

  function paint(animate: boolean, dt: number): void {
    ctx!.clearRect(0, 0, cssWidth, cssHeight);
    for (const p of particles) {
      if (animate) step(p, dt);
      drawParticle(p);
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
