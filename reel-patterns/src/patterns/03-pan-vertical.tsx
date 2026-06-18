// 03-pan-vertical.tsx — Tilt vertical continuo a través del chat.
//
// La cámara se queda centrada horizontalmente en el chat (focusX=1580)
// y hace un barrido vertical de arriba a abajo, "leyendo" cada sección:
//   - 0%   top:    topbar + greeting + mensaje del usuario
//   - 30%  upper:  mensaje + tool calls
//   - 50%  mid:    tool calls + tabla de sentencias
//   - 70%  lower:  tabla final + composer
//   - 100% bottom: composer (cierre)
//
// Es el complemento natural del patrón 2: mientras pan-h recorre el
// mundo en X (3 pantallas), pan-v recorre el chat en Y (5 secciones).
// Los dos patrones cubren los dos ejes del viewport portrait.

import { Camera } from "../camera/Camera";
import { World, calcTransform } from "../camera/World";
import {
  CAMERA_W,
  CAMERA_H,
  REST_SCALE,
  SCREEN_CENTERS_X,
} from "../camera/constants";
import { interp, useFrame, type Keyframe } from "../camera/useFrame";

// focusX constante: el viewport está centrado en el chat todo el
// recorrido. Solo se mueve en Y.
const KF_FOCUS_X: Keyframe[] = [
  { t: 0.000, value: SCREEN_CENTERS_X.chat },   // 1580
  { t: 1.000, value: SCREEN_CENTERS_X.chat },
];

// Tilt vertical continuo: barrido de focusY=180 (top) a focusY=620
// (bottom). Sin dwells, sin snaps — un solo movimiento lineal que
// desplaza la vista por las distintas zonas del chat.
//
//   focusY=180 → cámara muestra world y de ~10 a ~530
//                  (topbar, greeting, mensaje, tool calls, inicio tabla)
//   focusY=620 → cámara muestra world y de ~410 a ~820
//                  (cierre tabla + composer)
const KF_FOCUS_Y: Keyframe[] = [
  { t: 0.000, value: 180 },     // top: topbar + greeting + mensaje
  { t: 1.000, value: 620 },     // bottom: tabla final + composer
];

const CYCLE_MS = 7000;

export function PatternPanVertical() {
  const progress = useFrame({ cycleMs: CYCLE_MS });
  const fx = interp(KF_FOCUS_X, progress);
  const fy = interp(KF_FOCUS_Y, progress);
  const scale = REST_SCALE;

  const transform = calcTransform(scale, fx, fy, CAMERA_W, CAMERA_H);

  return (
    <Camera>
      <World transform={transform} />
    </Camera>
  );
}
