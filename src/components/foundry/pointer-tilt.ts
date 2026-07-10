/**
 * Pure geometry + gate for the Foundry pointer tilt/parallax/glare (visual-flair F7). Separated
 * from the {@link usePointerTilt} hook so the maths is unit-testable without a DOM: given a
 * pointer position *relative to the card's top-left* and the card's size, it returns the CSS
 * custom-property values the hook writes on the element — a few degrees of `rotateX`/`rotateY`,
 * a small counter-parallax offset for the raised "hero" layer, and the glare highlight's centre.
 *
 * Everything is bounded on purpose — the tilt is clamped to {@link DEFAULT_TILT_CONFIG.maxTiltDeg}
 * and the parallax to a small pixel offset — so the effect stays a restrained, premium lean rather
 * than a lurching flip, and can never become expensive.
 */

/** Tunable magnitudes for a tilt. Kept small — this is a subtle lean, not a somersault. */
export interface TiltConfig {
  /** Peak `rotateX`/`rotateY`, in degrees, reached when the pointer is at a card edge. */
  readonly maxTiltDeg: number;
  /** Peak counter-parallax shift of the hero layer, in px, at a card edge. */
  readonly parallaxPx: number;
}

/**
 * The default magnitudes. Deliberately gentle: ~6° of tilt and ~10px of parallax read as depth
 * without the card ever looking like it is falling over. Callers may override per surface, but
 * the defaults are what the Visual-density {@link ItemCard} uses.
 */
export const DEFAULT_TILT_CONFIG: TiltConfig = {
  maxTiltDeg: 6,
  parallaxPx: 10,
};

/** The CSS custom-property values a tilt resolves to — consumed by the `.gubbins-tilt` styles. */
export interface TiltVars {
  /** `rotateX` in degrees (leans the card so the pointer's row tips toward the viewer). */
  readonly rx: number;
  /** `rotateY` in degrees (leans the card so the pointer's column tips toward the viewer). */
  readonly ry: number;
  /** Hero-layer parallax offset X, in px (moves opposite the pointer for a counter-parallax). */
  readonly px: number;
  /** Hero-layer parallax offset Y, in px. */
  readonly py: number;
  /** Glare centre X, as a 0–100 percentage of the card width (tracks the pointer directly). */
  readonly gx: number;
  /** Glare centre Y, as a 0–100 percentage of the card height. */
  readonly gy: number;
}

/** The flat, at-rest values (no tilt, no parallax, glare centred) — the pointer-leave state. */
export const REST_TILT_VARS: TiltVars = { rx: 0, ry: 0, px: 0, py: 0, gx: 50, gy: 50 };

/** Clamp `n` to the inclusive `[min, max]` range. */
const clamp = (n: number, min: number, max: number): number => Math.min(Math.max(n, min), max);

/** Normalise a signed zero to `+0`, so a centred axis never writes an ugly `-0deg`/`-0px` var. */
const noNegZero = (n: number): number => (n === 0 ? 0 : n);

/**
 * Resolve a pointer position over a card to its tilt/parallax/glare CSS-var values.
 *
 * `pointerX`/`pointerY` are relative to the card's top-left; `width`/`height` are the card's box.
 * The pointer is normalised to `[-1, 1]` about the centre (clamped, since a pointer can sit a
 * hair outside the box between a `pointermove` and the frame that reads it):
 *
 *  - **Tilt** leans the card *toward* the pointer — the corner under the cursor rises toward the
 *    viewer. Signs are tuned for that reading and verified visually.
 *  - **Parallax** shifts the raised hero layer *against* the pointer offset, so it appears to
 *    float above the card face (a counter-parallax that sells the depth).
 *  - **Glare** centres a soft specular highlight directly under the pointer.
 *
 * A zero-size box (an unmeasured element, or happy-dom in tests) yields {@link REST_TILT_VARS}
 * rather than dividing by zero — so the hook never writes a `NaN` transform.
 */
export function computeTilt(
  pointerX: number,
  pointerY: number,
  width: number,
  height: number,
  config: TiltConfig = DEFAULT_TILT_CONFIG,
): TiltVars {
  if (width <= 0 || height <= 0) return REST_TILT_VARS;
  // Normalised pointer offset from centre, in [-1, 1]. -1 = left/top edge, +1 = right/bottom.
  const nx = clamp((pointerX / width) * 2 - 1, -1, 1);
  const ny = clamp((pointerY / height) * 2 - 1, -1, 1);
  return {
    // rotateX responds to the vertical offset, rotateY to the horizontal; the negations make the
    // card lean *toward* the cursor (near edge toward the viewer) rather than away from it.
    rx: noNegZero(-ny * config.maxTiltDeg),
    ry: noNegZero(nx * config.maxTiltDeg),
    // Hero layer drifts opposite the pointer for a counter-parallax.
    px: noNegZero(-nx * config.parallaxPx),
    py: noNegZero(-ny * config.parallaxPx),
    // Glare tracks the pointer directly, expressed as a percentage of the card box.
    gx: clamp((pointerX / width) * 100, 0, 100),
    gy: clamp((pointerY / height) * 100, 0, 100),
  };
}

/**
 * The pure motion gate, mirroring the F6 view-transition seam: state in, boolean out, so the hook
 * can't drift from a second reader. The tilt is decoration, so it is off whenever motion is reduced.
 *
 * **F9 seam (wired):** the hook feeds `reduced` from the shared decoration-motion gate
 * ({@link useDecorationMotionReduced}), which OR's the OS reduced-motion preference with the
 * "Reduce effects" appearance switch — so both turn the tilt off, from one place.
 *
 * Note this covers only the *motion* gate. Whether the device has a fine pointer (tilt is a
 * pointer-hover affordance, meaningless on touch) is an orthogonal check the hook ANDs in.
 */
export function computeShouldTilt(reduced: boolean): boolean {
  return !reduced;
}

/** The media query gating tilt to fine (mouse/trackpad/pen) pointers — never touch. */
export const FINE_POINTER_QUERY = '(pointer: fine)';
