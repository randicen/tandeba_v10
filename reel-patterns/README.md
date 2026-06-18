# reel-patterns

Prototipo de cinematografía para UI: cámara + mundo + travelling.

Muestra cómo animar una UI fija (Worgena) usando un modelo de
"cámara cinematográfica" que se desplaza por un mundo más grande.

## Modelo

- **Cámara** (viewport): 390×780 portrait, sin chrome de celular.
  Es solo un recorte limpio sobre el mundo — un "viewfinder" con
  proporciones verticales. Sin status bar, dynamic island ni home
  indicator.
- **Mundo** (world): 3160×820, compuesto por 3 pantallas
  distribuidas horizontalmente con gap de 80px:
  - **Sidebar** (x=0..1000): menú de Worgena
  - **Chat** (x=1080..2080): conversación con tabla de sentencias
  - **Tabla** (x=2160..3160): vista expandida de la tabla
- **Transform**: la cámara aplica `translate + scale` al mundo
  para encuadrar la región que quiere mostrar.

## Patrones

3 patrones cinematográficos, cada uno con su narrativa:

- **`01-zoom.tsx`** (8s): zoom narrativo de 5 actos sobre el primer
  veredicto de la tabla. WIDE → DOLLY → TIGHT (encuadre cerrado
  en el badge TUTELA de la fila 1) → HOLD → REVEAL.
- **`02-pan-horizontal.tsx`** (9s): travelling lateral continuo de
  izquierda a derecha, recorre las 3 pantallas sin dwells ni
  snaps. Sutil focus-pull 1.08× al pasar por el chat.
- **`03-pan-vertical.tsx`** (7s): tilt vertical continuo a través
  del chat, de top a bottom (greeting → mensaje → tabla → composer).

## Estructura

```
src/
├── camera/
│   ├── Camera.tsx       # viewport portrait, sin chrome
│   ├── constants.ts     # dimensiones, SCREEN_CENTERS_X
│   ├── useFrame.ts      # RAF + URL ?t= scrubber
│   └── World.tsx        # render del mundo (3 pantallas)
├── patterns/
│   ├── 01-zoom.tsx
│   ├── 02-pan-horizontal.tsx
│   └── 03-pan-vertical.tsx
├── screens/
│   ├── SidebarScreen.tsx
│   ├── ChatScreen.tsx
│   └── TableScreen.tsx
└── ui/
    ├── WorgenaUI.tsx    # UI base (también usada por Worgena)
    └── icons.tsx

scripts/
├── shot.mjs            # Playwright capture N frames por patrón
└── inspect-positions.mjs  # debug: encuentra world coords de un elemento vía DOM
```

## Cómo correr

```bash
npm install
npm run dev    # Vite en localhost:5180

# En otra terminal, capturar frames de cada patrón:
node scripts/shot.mjs zoom
node scripts/shot.mjs pan-h
node scripts/shot.mjs pan-v

# Debug: encontrar world coords de un elemento
node scripts/inspect-positions.mjs
```

Los screenshots se guardan en `scripts/shots/` (no commiteados).

## Notas de calibración

El `SUBJECT` del zoom (world coords del badge TUTELA de la fila 1)
se calibró empíricamente con `inspect-positions.mjs` — el cálculo
manual desde CSS pixel positions falla por el `zoom: 1.5` wrapper
y el `deviceScaleFactor=2` de Playwright.
