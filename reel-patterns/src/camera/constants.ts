// Camera constants — el "stage" donde ocurre todo.
//
// El mundo es un strip horizontal de 3 pantallas (sidebar | chat | tabla)
// envueltas en `zoom: 1.5` (que da la densidad fuente para que el
// `scale(N)` no se vea borroso). La cámara es un viewport portrait tipo
// iPhone que encuadra una porción del mundo. Los patrones manipulan la
// transformación del mundo dentro de la cámara — eso es lo que da la
// sensación de "cámara real" en vez de "estirar un PNG".

import { WORGENA_W, WORGENA_H } from "../ui/WorgenaUI";

// ─── Cámara ────────────────────────────────────────────────────────────────
// iPhone 14 Pro-ish, portrait (ratio 2:1). Alto > ancho, claramente vertical.
export const CAMERA_W = 390;
export const CAMERA_H = 780;
export const CAMERA_RADIUS = 36; // más curvo, más phone-like

// ─── Mundo ─────────────────────────────────────────────────────────────────
// 3 pantallas del UI (WorgenaUI 1000×700) en fila horizontal, con un gap
// entre ellas. Padding vertical para que la cámara no toque los bordes
// del mundo en sus pans.
export const SCREEN_W = WORGENA_W;        // 1000
export const SCREEN_H = WORGENA_H;        // 700
export const SCREEN_GAP = 80;            // espacio entre pantallas
export const SCREEN_PADDING_Y = 60;       // margen vertical arriba/abajo

export const WORLD_W = SCREEN_W * 3 + SCREEN_GAP * 2;   // 3160
export const WORLD_H = SCREEN_H + SCREEN_PADDING_Y * 2; // 820

// Escala de reposo: la cámara encaja una pantalla completa VERTICALMENTE.
// Esto es lo que da el travelling cinematográfico en cámara portrait:
// la cámara ve una franja vertical de ~350px del mundo a la vez, y se
// desliza horizontalmente para mostrar el resto de cada pantalla.
//
// REST_SCALE = CAMERA_H / SCREEN_H ≈ 1.114
//   (a 1.114x, 700px de pantalla se ven como 780px = alto completo de cámara)
export const REST_SCALE = CAMERA_H / SCREEN_H;

// Zoom máximo relativo a REST_SCALE para los patterns que hacen dolly-in.
// 2.0 = el doble del "fit completo".
export const ZOOM_MAX = 2.0;

// ─── Focales (centros X de cada pantalla, en coords del mundo) ─────────────
export const SCREEN_CENTERS_X = {
  sidebar: SCREEN_W / 2,                                    // 500
  chat:    SCREEN_W + SCREEN_GAP + SCREEN_W / 2,            // 1580
  table:   SCREEN_W * 2 + SCREEN_GAP * 2 + SCREEN_W / 2,    // 2660
} as const;

// Centro vertical del mundo (donde la cámara apunta en Y por defecto).
export const WORLD_CENTER_Y = WORLD_H / 2; // 410

// Foco en la `SentenciasTable` dentro del ChatScreen. Es el "money shot"
// (la tabla con tesis/resultado/artículo) y la única zona del chat que
// tiene densidad visual suficiente para llenar la cámara a zoom alto.
// En coords del mundo:
//   - X: el chat empieza en x=1080; la tabla vive a x≈300 dentro del chat
//     → centro ≈ 1380
//   - Y: la tabla está en la mitad inferior de la pantalla, ≈ 520
export const TABLE_FOCUS = { x: 1380, y: 520 };

export type ScreenKey = keyof typeof SCREEN_CENTERS_X;
