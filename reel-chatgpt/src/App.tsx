import { motion, AnimatePresence } from "motion/react";
import { useState, useEffect, useRef, useCallback } from "react";
import {
  BovedasScene,
  PromptScene,
  ProcesandoScene,
  ResultadosScene,
  ExportarScene,
  CierreScene,
} from "./scenes";

// Scene graph — ~19.5s of content + a final hold on the wordmark.
const SCENES = [
  { id: "bovedas",     label: "1 · Bóveda",     duration: 3200 },
  { id: "prompt",      label: "2 · Prompt",     duration: 3000 },
  { id: "procesando",  label: "3 · Procesando", duration: 4200 },
  { id: "resultados",  label: "4 · Resultados", duration: 5500 },
  { id: "exportar",    label: "5 · Exportar",   duration: 2800 },
  { id: "cierre",      label: "— Cierre",       duration: 99999 },
] as const;

type SceneId = (typeof SCENES)[number]["id"];

const easeEnter: [number, number, number, number] = [0.16, 1, 0.3, 1];

// Status line per scene — what the persistent chrome says above the demo card.
const SCENE_STATUS: Record<SceneId, { dot: string; label: string }> = {
  bovedas:    { dot: "#3b82f6", label: "Bóveda · Colombia" },
  prompt:     { dot: "#3b82f6", label: "Doctor Juan" },
  procesando: { dot: "#f59e0b", label: "Procesando" },
  resultados: { dot: "#10b981", label: "Listo" },
  exportar:   { dot: "#10b981", label: "Documento listo" },
  cierre:     { dot: "#10b981", label: "worgena.com" },
};

export default function App() {
  const [idx, setIdx] = useState(0);
  const timerRef = useRef<number | null>(null);

  // `?pause=1` freezes the sequencer — used by the screenshot script so we can
  // dwell on any single scene without the auto-advance firing.
  const paused =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("pause") === "1";

  const goTo = useCallback((next: number) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setIdx(Math.max(0, Math.min(next, SCENES.length - 1)));
  }, []);

  const advance = useCallback(() => {
    setIdx((i) => (i < SCENES.length - 1 ? i + 1 : i));
  }, []);

  // Auto-advance — capture timer ref, clear on cleanup
  useEffect(() => {
    if (paused) return;
    const scene = SCENES[idx];
    if (scene.duration >= 99999) return;
    timerRef.current = window.setTimeout(() => {
      setIdx((i) => Math.min(i + 1, SCENES.length - 1));
    }, scene.duration);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [idx, paused]);

  // Keyboard: space/arrow to advance, R to restart
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === " " || e.key === "ArrowRight") advance();
      if (e.key === "ArrowLeft") goTo(idx - 1);
      if (e.key === "r" || e.key === "R") goTo(0);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [advance, goTo, idx]);

  const current = SCENES[idx];
  const status = SCENE_STATUS[current.id as SceneId];

  return (
    <div className="w-screen h-screen bg-[#0a0a0a] flex items-center justify-center overflow-hidden font-sans">
      {/* 9:16 vertical container — scales to viewport */}
      <div
        className="relative bg-[#0a0a0a] flex-shrink-0"
        style={{
          width: "min(100vw, calc(100vh * 9 / 16))",
          height: "min(100vh, calc(100vw * 16 / 9))",
          maxWidth: "500px",
          maxHeight: "calc(500px * 16 / 9)",
        }}
        onClick={advance}
      >
        {/* Persistent Worgena chrome — clean wordmark + live status */}
        <WorgenaChrome dotColor={status.dot} status={status.label} />

        {/* Demo card (morphing) — single card whose contents change */}
        <div
          className="absolute left-0 right-0 mx-auto bg-[#fafafa] rounded-2xl overflow-hidden shadow-[0_8px_40px_rgba(0,0,0,0.5)]"
          style={{
            top: "16%",
            bottom: "9%",
            width: "92%",
          }}
        >
          <AnimatePresence mode="wait">
            <motion.div
              key={current.id}
              className="absolute inset-0"
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -16 }}
              transition={{ duration: 0.45, ease: easeEnter }}
            >
              {current.id === "bovedas"    && <BovedasScene active={true} />}
              {current.id === "prompt"     && <PromptScene active={true} />}
              {current.id === "procesando" && <ProcesandoScene active={true} />}
              {current.id === "resultados" && <ResultadosScene active={true} />}
              {current.id === "exportar"   && <ExportarScene active={true} />}
              {current.id === "cierre"     && <CierreScene active={true} />}
            </motion.div>
          </AnimatePresence>
        </div>

        {/* Top-left scene label */}
        <div className="absolute top-2 left-3 text-[9px] text-white/30 font-mono">
          {current.label}
        </div>

        {/* Bottom progress dots + hint */}
        <div className="absolute bottom-2 left-0 right-0 flex flex-col items-center gap-1.5">
          <div className="flex gap-1">
            {SCENES.map((_, i) => (
              <button
                key={i}
                onClick={(e) => { e.stopPropagation(); goTo(i); }}
                className={`h-1 rounded-full transition-all duration-300 ${
                  i === idx ? "w-6 bg-white" : "w-1.5 bg-white/25 hover:bg-white/40"
                }`}
                aria-label={`Ir a escena ${i + 1}`}
              />
            ))}
          </div>
          <div className="text-[8px] text-white/25 font-mono">
            clic · space · ←/→
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Persistent Worgena chrome — replaces the tweet card from the reference.
 * Intentionally minimal: wordmark + live status dot. No avatar, no @handle,
 * no tweet text, no SVG tail. The "what is this product" question is answered
 * by the morphing demo card below.
 */
function WorgenaChrome({ dotColor, status }: { dotColor: string; status: string }) {
  return (
    <motion.div
      className="absolute left-0 right-0 mx-auto z-10 flex items-center justify-between px-3 py-2"
      style={{ top: "4%", width: "88%" }}
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: easeEnter, delay: 0.1 }}
    >
      {/* Wordmark — Worgena, set in a clean sans-serif */}
      <div className="flex items-center gap-2">
        <div className="w-6 h-6 rounded-md bg-white flex items-center justify-center">
          <span className="text-[11px] font-bold text-gray-900 tracking-tight">W</span>
        </div>
        <span className="text-white text-[13px] font-semibold tracking-tight">Worgena</span>
      </div>

      {/* Live status pill */}
      <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-white/8 backdrop-blur-sm">
        <motion.span
          className="w-1.5 h-1.5 rounded-full"
          style={{ backgroundColor: dotColor }}
          animate={{ opacity: [1, 0.4, 1] }}
          transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
        />
        <span className="text-[9.5px] text-white/70 font-medium tracking-wide">{status}</span>
      </div>
    </motion.div>
  );
}
