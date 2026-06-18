// 01-zoom.tsx — Zoom narrativo sobre el primer veredicto de la tabla.
//
// Cuenta una historia en 5 actos a través del chat:
//   1. WIDE   : se ve la conversación (greeting + mensaje + tabla)
//   2. DOLLY  : la cámara se aproxima a la tabla de sentencias
//   3. TIGHT  : encuadre cerrado sobre la PRIMERA fila de la tabla
//               (T-622/16 · "Río como sujeto de derechos" · badge TUTELA)
//   4. HOLD   : se queda en el veredicto (el momento de "lectura")
//   5. REVEAL : vuelve a wide
//
// El subject NO es un punto arbitrario en el centro de la tabla — es
// la primera fila completa, que es una "unidad de veredicto" con
// identidad: tiene ID (T-622/16), tesis ("Río como sujeto de
// derechos"), badge (TUTELA verde) y artículo (CP 7, 8, 79). Al
// encuadrarlo, el usuario entiende "estamos mirando el primer
// resultado del análisis", no "estamos mirando la tabla en general".

import { Camera } from "../camera/Camera";
import { World, calcTransform } from "../camera/World";
import { CAMERA_W, CAMERA_H, REST_SCALE } from "../camera/constants";
import { interp, useFrame, type Keyframe } from "../camera/useFrame";

// ─── SUBJECT (target del tight zoom) ────────────────────────────────────────
//
// El SUBJECT es la primera fila de la SentenciasTable — un veredicto
// con identidad (ID, tesis, badge, artículo). Para el TIGHT encuadre
// queremos la cámara centrada en el BADGE TUTELA de la fila 1, que es
// el "gancho" narrativo (el usuario entiende "estamos mirando el
// primer resultado del análisis", no "mirando la tabla en general").
//
// Coordenadas medidas empíricamente con Playwright en el WIDE shot
// (fx=1580, fy=380, scale=1.114): el badge Tutela de la fila 1 está
// a viewport (333, 484) — eso es world (1704, 464).
const SUBJECT = { x: 1704, y: 464 };

// ─── Keyframes de los 5 actos ───────────────────────────────────────────────
//
// WIDE: muestra el chat completo (greeting + mensaje + tabla lejana).
//   En REST_SCALE, la cámara ve 350×700 world-px; con fx=1580 (centro
//   del chat) y fy=380 (mitad superior del chat), encuadra la
//   conversación con la tabla como "destino" abajo.
//
// MID: se acerca a la tabla. A 1.5× REST_SCALE ve 233×467 world-px;
//   con fx=1704 (centro de la tabla) y fy=440, muestra la tabla con
//   sus 3 filas enteras y contexto de chat arriba/abajo.
//
// TIGHT: frame cerrado en la primera fila. A 2.5× REST_SCALE ve
//   140×280 world-px; centrado en SUBJECT muestra la fila 1 con el
//   badge TUTELA grande y legible.
const WIDE = { fx: 1580, fy: 380, k: 1.0 };
const MID = { fx: 1704, fy: 440, k: 1.5 };
const TIGHT = { fx: SUBJECT.x, fy: SUBJECT.y, k: 2.5 };

const KF_FOCUS_X: Keyframe[] = [
  { t: 0.000, value: WIDE.fx },
  { t: 0.150, value: WIDE.fx },     // 1. WIDE — hold
  { t: 0.350, value: MID.fx },      // 2. DOLLY — drift hacia tabla
  { t: 0.520, value: TIGHT.fx },    // 3. TIGHT — llegar al veredicto
  { t: 0.750, value: TIGHT.fx },    // 4. HOLD — quedarse leyendo
  { t: 0.900, value: WIDE.fx },     // 5. REVEAL — pull-back
  { t: 1.000, value: WIDE.fx },     //    loop
];

const KF_FOCUS_Y: Keyframe[] = [
  { t: 0.000, value: WIDE.fy },
  { t: 0.150, value: WIDE.fy },
  { t: 0.350, value: MID.fy },
  { t: 0.520, value: TIGHT.fy },
  { t: 0.750, value: TIGHT.fy },
  { t: 0.900, value: WIDE.fy },
  { t: 1.000, value: WIDE.fy },
];

const KF_SCALE: Keyframe[] = [
  { t: 0.000, value: WIDE.k },
  { t: 0.150, value: WIDE.k },      // hold wide
  { t: 0.350, value: MID.k },       // dolly to mid (1.6×)
  { t: 0.520, value: TIGHT.k },     // dolly to tight (2.5×)
  { t: 0.720, value: TIGHT.k },     // hold tight
  { t: 0.900, value: WIDE.k },      // pull-back a wide
  { t: 1.000, value: WIDE.k },      // hold wide
];

const CYCLE_MS = 8000;

export function PatternZoom() {
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
