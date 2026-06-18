// useFrame.ts — utilidad para manejar el ciclo de cada patrón con scrub
// (`?t=<ms>`) y loop automático.
//
// Cada patrón define su propio ciclo (KEYFRAMES), y este hook resuelve
// `t → progress → params del frame`. El patrón usa esos params para
// calcular scale/focus/etc.

import { useEffect, useState } from "react";

export interface Keyframe {
  /** Tiempo normalizado 0..1 */
  t: number;
  /** Valor en este keyframe */
  value: number;
}

/** Interpola linealmente entre keyframes (ordenados por `t`). */
export function interp(keyframes: Keyframe[], progress: number): number {
  if (progress <= keyframes[0].t) return keyframes[0].value;
  if (progress >= keyframes[keyframes.length - 1].t) {
    return keyframes[keyframes.length - 1].value;
  }
  for (let i = 0; i < keyframes.length - 1; i++) {
    const a = keyframes[i];
    const b = keyframes[i + 1];
    if (progress >= a.t && progress <= b.t) {
      const local = (progress - a.t) / (b.t - a.t);
      return a.value + (b.value - a.value) * local;
    }
  }
  return keyframes[keyframes.length - 1].value;
}

export interface UseFrameOptions {
  /** Duración del ciclo en ms. */
  cycleMs: number;
}

/**
 * Devuelve el `progress` actual del ciclo (0..1), avanzando con el reloj.
 *
 * Si la URL tiene `?t=<ms>`, se congela en ese frame (modo scrub para
 * Playwright). Si no, entra en loop infinito.
 */
export function useFrame({ cycleMs }: UseFrameOptions): number {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tParam = params.get("t");
    if (tParam !== null) {
      const ms = Number(tParam);
      const wrapped = ((ms % cycleMs) + cycleMs) % cycleMs;
      setProgress(wrapped / cycleMs);
      return;
    }
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const elapsed = (now - start) % cycleMs;
      setProgress(elapsed / cycleMs);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [cycleMs]);

  return progress;
}