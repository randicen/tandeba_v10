import React, { useState, useRef } from 'react';
import { PromptComposer } from './PromptComposer';

interface SpaceChatInputProps {
  spaceId: string;
  onThreadCreated: (sessionId: string) => void;
  disabled?: boolean;
}

/**
 * SpaceChatInput
 * -----------------------------------------------------------------------------
 * Composer compacto que vive en la vista detalle de un Espacio. Crea una sesión
 * nueva con el primer mensaje del usuario, dispara el step del agente, y
 * delega la navegación al `onThreadCreated`.
 *
 * Es un wrapper delgado sobre el `PromptComposer` para que la experiencia sea
 * idéntica al composer del chat global.
 */
export function SpaceChatInput({ spaceId, onThreadCreated, disabled }: SpaceChatInputProps) {
  const [sending, setSending] = useState(false);
  const isSubmittingRef = useRef(false);

  const handleSubmit = async (value: string) => {
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setSending(true);
    try {
      // 1. Crear la sesión con el spaceId del Espacio activo.
      const createRes = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: value.slice(0, 60), spaceId }),
      });
      if (!createRes.ok) throw new Error(`HTTP ${createRes.status}`);
      const session = await createRes.json();
      const sessionId: string = session.id;

      // 2. Persistir el contenido como primer mensaje del usuario.
      const msgRes = await fetch(`/api/sessions/${sessionId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: value }),
      });
      if (!msgRes.ok) throw new Error(`HTTP ${msgRes.status}`);

      // 3. Disparar el step. Si el server ya está ejecutando otro step lo
      // ignora (activeExecutions), así que es seguro disparar también desde
      // el ChatArea si lo hace.
      fetch(`/api/sessions/${sessionId}/step`, { method: 'POST' }).catch((e) =>
        console.error('Step trigger from space input failed:', e)
      );

      onThreadCreated(sessionId);
    } catch (e) {
      console.error('Error creating thread:', e);
    } finally {
      isSubmittingRef.current = false;
      setSending(false);
    }
  };

  return (
    <div className="border-t border-gray-200 bg-white p-2 sm:p-4 shrink-0">
      <PromptComposer
        variant="compact"
        placeholder="Escribe un mensaje al asistente para iniciar un nuevo hilo..."
        disabled={disabled || sending}
        onSubmit={(text) => { void handleSubmit(text); }}
      />
    </div>
  );
}
