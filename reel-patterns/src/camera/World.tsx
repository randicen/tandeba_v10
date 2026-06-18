// World.tsx — el "stage" donde viven las 3 pantallas.
//
// El mundo es un strip horizontal de 3 pantallas (sidebar | chat | tabla)
// renderizadas como HTML. La cámara encuadra una porción aplicando
// `transform: translate() scale()` al mundo entero.
//
// **Nota sobre el `zoom: 1.5` que NO usamos aquí**: en un modelo anterior
// se usaba un wrapper `zoom: 1.5` con la idea (equivocada) de "forzar
// re-raster del texto para que no se estire como un bitmap". Eso era
// cierto para `<canvas>` o `<img>` estáticos, pero NO para texto HTML:
// los glyphs ya se re-rasterizan en cada cambio de `transform: scale()`.
// El wrapper `zoom` solo introducía un mismatch entre coords pre-zoom y
// post-zoom que descuadraba `calcTransform`.
//
// La transformación se calcula para que un punto `focus` (en coords del
// mundo) quede siempre en el centro de la cámara — esto es lo que da la
// sensación de "la cámara apunta a X".

import type { CSSProperties } from "react";
import {
  WORLD_W,
  WORLD_H,
  SCREEN_W,
  SCREEN_H,
  SCREEN_GAP,
  SCREEN_PADDING_Y,
} from "./constants";
import { SidebarScreen } from "../screens/SidebarScreen";
import { ChatScreen } from "../screens/ChatScreen";
import { TableScreen } from "../screens/TableScreen";

export interface WorldTransform {
  scale: number;
  tx: number; // translate-x en px (de coords del mundo → coords del camera)
  ty: number;
}

interface WorldProps {
  transform: WorldTransform;
}

const baseStyle: CSSProperties = {
  position: "absolute",
  top: 0,
  left: 0,
  width: WORLD_W,
  height: WORLD_H,
  transformOrigin: "0 0",
  willChange: "transform",
};

export function World({ transform }: WorldProps) {
  return (
    <div
      style={{
        ...baseStyle,
        transform: `translate(${transform.tx}px, ${transform.ty}px) scale(${transform.scale})`,
      }}
    >
      {/* Strip horizontal de 3 pantallas, centradas verticalmente. Sin
          padding horizontal — el `gap` del flex ya separa las pantallas,
          y el padding horizontal descuadraba las SCREEN_CENTERS_X (los
          centros calculados asumían x=0 en el inicio del mundo). */}
      <div
        style={{
          display: "flex",
          gap: SCREEN_GAP,
          padding: `${SCREEN_PADDING_Y}px 0`,
          alignItems: "center",
        }}
      >
        <ScreenShell>
          <SidebarScreen />
        </ScreenShell>
        <ScreenShell>
          <ChatScreen />
        </ScreenShell>
        <ScreenShell>
          <TableScreen />
        </ScreenShell>
      </div>
    </div>
  );
}

function ScreenShell({ children }: { children: React.ReactNode }) {
  // Cada screen mantiene su tamaño natural (SCREEN_W × SCREEN_H). Las
  // gaps vienen del flex `gap` del padre.
  return (
    <div style={{ width: SCREEN_W, height: SCREEN_H, flexShrink: 0 }}>
      {children}
    </div>
  );
}

// Helper: calcula la transformación que pone `focus` (en coords del mundo)
// en el centro de una cámara de tamaño (cw × ch).
export function calcTransform(
  scale: number,
  focusX: number,
  focusY: number,
  cameraW: number,
  cameraH: number,
): WorldTransform {
  return {
    scale,
    tx: cameraW / 2 - focusX * scale,
    ty: cameraH / 2 - focusY * scale,
  };
}
