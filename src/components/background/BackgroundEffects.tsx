/**
 * BackgroundEffects — the app-wide animated weather layer (spec: decorative background effects).
 *
 * Mounted once at the composition root (`routes/__root.tsx`), it paints the chosen effect
 * (`usePreferencesStore.backgroundEffect`: none / rain / snow) onto a single full-viewport
 * `<canvas>` fixed behind all UI (`-z-10`, above the page background, below every screen's
 * content — the same layering the About {@link import('../../features/about/Starfield').Starfield}
 * uses). The particle work lives in the framework-agnostic {@link startPrecip} engine; this
 * component only wires it to React state and the shared decoration-motion gate.
 *
 * - **Off by default.** When the effect is `none` nothing renders — no canvas, no listeners, no
 *   frames — so the baseline is completely untouched.
 * - **Animation level.** The layer is an ambient decoration, so it tracks the graded animation
 *   level exactly like the starfield: it animates at the livelier tiers, holds a single static
 *   frame at Calm (folded into {@link useDecorationMotionReduced} with the OS `prefers-reduced-
 *   motion` setting), and drops out entirely at Minimal/Off (`suppressesAmbient`). A canvas is
 *   invisible to the CSS `data-anim-level` / reduced-motion catch-alls, so these gates are applied
 *   here in JS.
 * - **Theme-correct.** The engine reads its colours from the `--precip-*` tokens; a light/dark
 *   change (explicit mode / OLED / high-contrast, or an OS scheme flip under `system`) triggers a
 *   colour refresh without resetting the falling field.
 */
import { useEffect, useRef } from 'react';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useDecorationMotionReduced } from '@/components/foundry/decoration-motion';
import { suppressesAmbient } from '@/features/settings/theme-registry';
import { startPrecip, type PrecipController } from './precip-engine';

export function BackgroundEffects() {
  const effect = usePreferencesStore((s) => s.backgroundEffect);
  const reduced = useDecorationMotionReduced();
  // Minimal/Off switch ambient decorations off entirely (not just freeze them), like the starfield.
  const ambientOff = usePreferencesStore((s) => suppressesAmbient(s.animationLevel));
  // Theme-affecting prefs: a change re-reads the token colours (no pool reset).
  const mode = usePreferencesStore((s) => s.mode);
  const oledDark = usePreferencesStore((s) => s.oledDark);
  const highContrast = usePreferencesStore((s) => s.highContrast);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<PrecipController | null>(null);
  const hidden = effect === 'none' || ambientOff;

  // Start/stop the engine when the chosen effect, the motion gate or the ambient cutoff changes.
  useEffect(() => {
    if (hidden) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const controller = startPrecip(canvas, { kind: effect, reduced });
    controllerRef.current = controller;
    return () => {
      controller.stop();
      controllerRef.current = null;
    };
  }, [effect, reduced, hidden]);

  // Re-read the token colours when the resolved theme changes (explicit axes).
  useEffect(() => {
    controllerRef.current?.refresh();
  }, [mode, oledDark, highContrast]);

  // …and when the OS colour scheme flips under `system` mode (no store field changes then).
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const media = matchMedia('(prefers-color-scheme: dark)');
    const onScheme = () => controllerRef.current?.refresh();
    media.addEventListener('change', onScheme);
    return () => media.removeEventListener('change', onScheme);
  }, []);

  if (hidden) return null;
  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      data-testid="background-effects"
      className="print-hide pointer-events-none fixed inset-0 -z-10 h-full w-full"
    />
  );
}
