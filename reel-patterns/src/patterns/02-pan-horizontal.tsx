// 02-pan-horizontal.tsx — Travelling lateral CONTINUO.
//
// Un solo barrido de izquierda a derecha a través del mundo entero,
// sin dwells ni snaps. La cámara entra desde el borde izquierdo del
// sidebar, pasa por las 3 pantallas (sidebar → chat → tabla) y sale
// por el borde derecho de la tabla. Movimiento continuo.
//
// Esto es lo que el usuario pidió: "travelling lateral" — un
// desplazamiento continuo, no un teleport entre focales. La velocidad
// es casi uniforme, con un sutil focus-pull a la mitad del recorrido
// (escala 1.08) para añadir dramatismo sin romper la continuidad.
//
// Loop de 9 segundos (más largo que los zooms para que el travelling
// se aprecie sin sensación de urgencia).

import { Camera } from "../camera/Camera";
import { World, calcTransform } from "../camera/World";
import {
  CAMERA_W,
  CAMERA_H,
  REST_SCALE,
  WORLD_H,
} from "../camera/constants";
import { interp, useFrame, type Keyframe } from "../camera/useFrame";

// Movimiento X: lineal de extremo a extremo del mundo (x=100 a x=3060).
// Sin dwells. El `interp()` interpola linealmente entre keyframes, así
// que con solo 2 keyframes el movimiento es perfectamente continuo.
const KF_FOCUS_X: Keyframe[] = [
  { t: 0.000, value: 100 },    // entrando por el borde izq del sidebar
  { t: 1.000, value: 3060 },   // saliendo por el borde der de la tabla
];

// Drift vertical sutil: la cámara no va perfectamente recta — sube y
// baja unos 30px en el recorrido, como un travelling handheld.
const KF_FOCUS_Y: Keyframe[] = [
  { t: 0.000, value: 400 },
  { t: 0.500, value: 430 },
  { t: 1.000, value: 400 },
];

// Focus pull sutil: cuando la cámara llega al chat (centro del
// recorrido, t≈0.5), se acerca un poco (1.08x). Vuelve a 1.0 al final.
// Es un toque de dramatismo — el chat es la pantalla principal, así
// que merece un micro-dolly-in al pasar por ella.
const KF_SCALE: Keyframe[] = [
  { t: 0.000, value: 1.00 },
  { t: 0.350, value: 1.00 },
  { t: 0.500, value: 1.08 },
  { t: 0.650, value: 1.00 },
  { t: 1.000, value: 1.00 },
];

const CYCLE_MS = 9000;

export function PatternPanHorizontal() {
  const progress = useFrame({ cycleMs: CYCLE_MS });
  const fx = interp(KF_FOCUS_X, progress);
  const fy = interp(KF_FOCUS_Y, progress);
  const scale = REST_SCALE * interp(KF_SCALE, progress);

  const transform = calcTransform(scale, fx, fy, CAMERA_W, CAMERA_H);

  return (
    <Camera>
      <World transform={transform} />
    </Camera>
  );
}
