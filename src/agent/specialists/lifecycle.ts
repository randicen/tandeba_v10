/**
 * Worgena — Lifecycle (D2b.2).
 *
 * Fuente de verdad: `AGENT_D2B_2_SPEC.md` §3.6, §5.5.
 *
 * State machine simple de 6 estados para el ciclo de vida de un
 * specialist (o agent en general):
 *
 *   spawn → idle → busy → (done | paused | archived)
 *                ↑   ↓
 *                └───┘ (paused → busy en resume)
 *
 * Reglas de transición (ver spec §3.6):
 * - spawn → idle (registrado en el registry)
 * - idle → busy (ejecutando) o archived (cleanup sin uso)
 * - busy → done (completó) o paused (HITL) o archived (error fatal)
 * - paused → busy (resume) o archived
 * - done → busy (re-ejecución) o archived
 * - archived → (terminal, no más transiciones)
 *
 * **Decisión clave** (§3.6): NO usamos `xstate` ni libs externas. La
 * lógica es trivial (6 estados, transiciones explícitas) y agregar
 * una dep para esto es overkill. El motor no consulta el lifecycle en
 * runtime (no necesita "saber" si el specialist está busy) — es para
 * audit y observabilidad.
 *
 * **Eventos in-memory** (§2.1 goal 6): cada transición emite un evento
 * con `{from, to, at, reason}`. El `events` array se popula en orden.
 * Persistencia a DB es D3+ (multi-tenant).
 *
 * **Backward-compat**: el lifecycle es aditivo. No cambia el contrato
 * `Specialist.execute()`. Los tests existentes no se rompen.
 */

import { randomUUID } from "node:crypto";

// ============================================================
// Tipos públicos
// ============================================================

/**
 * Estados del lifecycle. Mantener el orden de severidad (de menos
 * maduro a más terminal) ayuda a la lectura en logs.
 */
export type LifecycleState =
  | "spawn"
  | "idle"
  | "busy"
  | "paused"
  | "done"
  | "archived";

/**
 * Evento emitido en cada transición. Es append-only.
 */
export interface LifecycleEvent {
  readonly from: LifecycleState;
  readonly to: LifecycleState;
  /** ISO 8601 timestamp de cuándo ocurrió la transición. */
  readonly at: string;
  /** Razón legible de la transición (ej: "node foo starting", "error: timeout"). */
  readonly reason?: string;
}

/**
 * Callback opcional invocado en cada transición. Útil para observabilidad
 * (logs estructurados, métricas) o para emitir eventos a un bus.
 *
 * **NIT-2 (audit D2 2026-06-12)**: el callback DEBE ser síncrono.
 * Si se vuelve async en el futuro, la transición ya ocurrió antes
 * de que el callback complete, así que no hay forma de "cancelar"
 * la transición desde el callback. Si el caller necesita async,
 * que enqueue un job en su propio sistema y retorne sync.
 */
export type LifecycleListener = (
  newState: LifecycleState,
  prev: LifecycleState,
  reason?: string,
) => void;

// ============================================================
// Tabla de transiciones (función pura)
// ============================================================

/**
 * Tabla de transiciones válidas. `from` → `to` permitidos.
 *
 * **Por qué exportada y pura**: testeable independientemente del
 * Lifecycle. Los tests D2b.2 validan que la tabla cumple el spec §3.6.
 *
 * **No mutar**: el objeto está freezed. Los callers que quieran
 * transiciones custom (no debería pasar) crean su propia tabla.
 *
 * **Decisión de diseño D2b.2 (post-implementación)**: el `done → busy`
 * está permitido porque el `SpecialistRegistry` comparte instancias
 * entre tasks (un specialist se reusa en `task1` y luego en el `replay`
 * de `task1`). El lifecycle trackea la vida del specialist, no de
 * cada ejecución individual. Sin esta transición, el replay falla
 * con `INTERNAL_ERROR` (bug descubierto en test D2a.5 al implementar
 * D2b.2 — el spec original no lo cubría explícitamente).
 */
export const LIFECYCLE_TRANSITIONS: Readonly<Record<LifecycleState, readonly LifecycleState[]>> = Object.freeze({
  spawn: ["idle"],
  idle: ["busy", "archived"],
  busy: ["done", "paused", "archived"],
  paused: ["busy", "archived"],
  done: ["busy", "archived"],
  archived: [],
});

/**
 * Helper puro: dada una transición, ¿es válida?
 */
export function isValidLifecycleTransition(
  from: LifecycleState,
  to: LifecycleState,
): boolean {
  return LIFECYCLE_TRANSITIONS[from].includes(to);
}

// ============================================================
// Lifecycle
// ============================================================

/**
 * State machine del lifecycle de un specialist (o agent).
 *
 * **Una instancia por specialist**: el lifecycle es por-instancia,
 * no global. Cada `IntakeSpecialist` tiene su propio `Lifecycle` con
 * sus eventos. Esto permite que múltiples instancias del mismo agent
 * corran en paralelo sin compartir estado.
 *
 * **Single-threaded**: JavaScript es single-threaded, así que las
 * transiciones son atómicas por construcción. No hay race conditions
 * entre transitions.
 */
export class Lifecycle {
  private _state: LifecycleState = "spawn";
  private readonly _events: LifecycleEvent[] = [];
  readonly createdAt: string;
  private _stateChangedAt: string;

  /**
   * Callback opcional invocado en cada transición.
   *
   * **Importante**: no debe tirar errores. Si tira, la transición ya
   * ocurrió y el error se propaga fuera del lifecycle, contaminando
   * la ejecución del specialist. El lifecycle se defiende: captura
   * errores del callback y los silencia (defensa en profundidad).
   */
  public onStateChange?: LifecycleListener;

  constructor() {
    const now = new Date().toISOString();
    this.createdAt = now;
    // stateChangedAt arranca en `spawn` (mismo timestamp que createdAt);
    // la primera `transition()` lo actualiza. MIN-1 (audit D2 2026-06-12):
    // esto confunde a quien lee el código por primera vez — el comment
    // aclara que es intencional.
    this._stateChangedAt = now;
  }

  /** Estado actual. Read-only. */
  get state(): LifecycleState {
    return this._state;
  }

  /**
   * Historial completo de eventos. Append-only.
   *
   * El array es `readonly` desde afuera (no se puede hacer push),
   * pero internamente se popula en cada `transition()`. Para el
   * caller, es una vista inmutable.
   */
  get events(): readonly LifecycleEvent[] {
    return this._events;
  }

  /**
   * Timestamp ISO de la última transición. **Redundante** con
   * `events[events.length - 1].at` (siempre iguales). MIN-3 (audit
   * D2 2026-06-12): se mantiene por backward-compat con callers que
   * leen `stateChangedAt` directamente. Forward-compat: D3+ podría
   * marcar este getter como `@deprecated` y derivar de `events`.
   */
  get stateChangedAt(): string {
    return this._stateChangedAt;
  }

  /**
   * Transiciona al estado `next`. Tira `Error` si la transición no
   * es válida (ver `LIFECYCLE_TRANSITIONS`).
   *
   * @param next - Estado destino.
   * @param reason - Razón legible. Se incluye en el evento y se pasa
   *   al listener. Útil para debug y audit ("node foo starting",
   *   "error: TIMEOUT", "paused por HITL request #abc-123").
   */
  transition(next: LifecycleState, reason?: string): void {
    if (!isValidLifecycleTransition(this._state, next)) {
      throw new Error(
        `Invalid lifecycle transition: ${this._state} → ${next} ` +
          `(transiciones válidas desde ${this._state}: ` +
          `${LIFECYCLE_TRANSITIONS[this._state].join(", ") || "(none)"})`,
      );
    }
    const prev = this._state;
    this._state = next;
    this._stateChangedAt = new Date().toISOString();
    const event: LifecycleEvent = {
      from: prev,
      to: next,
      at: this._stateChangedAt,
      ...(reason !== undefined ? { reason } : {}),
    };
    this._events.push(event);

    // Invocar listener de forma defensiva. Si tira, no queremos que
    // el error se propague y arruine la transición (que ya ocurrió).
    if (this.onStateChange !== undefined) {
      try {
        this.onStateChange(next, prev, reason);
      } catch {
        // Intencionalmente silenciamos. El caller puede inspeccionar
        // `events` para ver si la transición ocurrió.
      }
    }
  }

  /**
   * Helper: ¿está en un estado terminal (no más transiciones)?
   *
   * Hoy solo `archived` es terminal. Útil para validaciones antes de
   * intentar transicionar (ej: el motor chequea que el lifecycle no esté
   * archived antes de empezar un nuevo `execute()`).
   */
  isTerminal(): boolean {
    return this._state === "archived";
  }
}

// ============================================================
// Helpers de tests
// ============================================================

/**
 * Helper para tests: genera un `modelId` único (útil para tests que
 * quieren aislar entradas del catálogo sin colisionar entre sí).
 *
 * No se exporta en el barrel — solo se usa internamente.
 */
export function _uniqueModelIdForTests(prefix: string = "test-model"): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}
