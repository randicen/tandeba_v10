// App.tsx — Selector de patrones vía `?pattern=zoom|pan-h|pan-v`.
//
// Default: `zoom`. Cada patrón vive en su propio archivo y comparte el
// setup de cámara + mundo (`src/camera/`).

import { PatternZoom } from "./patterns/01-zoom";
import { PatternPanHorizontal } from "./patterns/02-pan-horizontal";
import { PatternPanVertical } from "./patterns/03-pan-vertical";

export default function App() {
  const params = new URLSearchParams(window.location.search);
  const pattern = params.get("pattern") ?? "zoom";

  switch (pattern) {
    case "pan-h":
      return <PatternPanHorizontal />;
    case "pan-v":
      return <PatternPanVertical />;
    case "zoom":
    default:
      return <PatternZoom />;
  }
}