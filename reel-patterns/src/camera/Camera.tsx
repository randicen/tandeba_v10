// Camera.tsx — viewport vertical limpio.
//
// Lo único que importa aquí es el aspect ratio portrait (390×780, ~2:1,
// la "característica tamaño vertical" de un celular) y nada más. NO hay
// status bar, dynamic island ni home indicator — eso era "el marco que
// simula un celular" y el usuario explícitamente no lo quiere.
//
// Piensa en esto como un viewfinder / ventana de cine con proporciones
// de celular: bordes casi rectos, sin device chrome, sin notch, sin bar
// inferior. Solo un recorte limpio sobre el mundo más grande.

import type { ReactNode } from "react";
import { CAMERA_W, CAMERA_H } from "./constants";

interface CameraProps {
  children: ReactNode;
  width?: number;
  height?: number;
}

export function Camera({
  children,
  width = CAMERA_W,
  height = CAMERA_H,
}: CameraProps) {
  return (
    <div
      className="w-screen h-screen flex items-center justify-center"
      style={{
        // Fondo gris muy oscuro (no negro puro) — un "stage" neutro
        // sobre el que el viewport se recorta, no la oscuridad total
        // del "filmar en la noche".
        background: "#111113",
        padding: 24,
      }}
    >
      <div
        data-camera="1"
        style={{
          width,
          height,
          // Radio mínimo — un sutil suavizado para que no parezca un
          // recorte de papel, pero muy lejos del "bezel redondeado
          // de celular" que tenía antes (CAMERA_RADIUS = 36).
          borderRadius: 6,
          overflow: "hidden",
          position: "relative",
          background: "white",
          // Sombra única y suave — "el viewport está flotando sobre el
          // stage", no "es un dispositivo físico con bisel y ring".
          boxShadow: "0 24px 60px -12px rgba(0,0,0,0.55)",
        }}
      >
        {/* Mundo transformado dentro del viewport */}
        <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
          {children}
        </div>
      </div>
    </div>
  );
}
