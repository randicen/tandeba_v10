import { useState, useRef, KeyboardEvent } from 'react';
import { Send, Loader2 } from 'lucide-react';

interface SpaceChatInputProps {
  spaceId: string;
  onThreadCreated: (sessionId: string) => void;
  disabled?: boolean;
}

export function SpaceChatInput({ spaceId, onThreadCreated, disabled }: SpaceChatInputProps) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const send = async () => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: value.slice(0, 60), spaceId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const session = await res.json();
      setText('');
      onThreadCreated(session.id);
    } catch (e) {
      console.error('Error creating thread:', e);
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="border-t border-gray-200 bg-white p-3 sm:p-4 shrink-0">
      <div className="max-w-3xl mx-auto relative flex items-end gap-2 rounded-2xl bg-gray-50 border border-gray-300 focus-within:border-blue-500 focus-within:ring-4 focus-within:ring-blue-500/10 transition-all p-1.5 shadow-sm">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Escribe un mensaje al asistente para iniciar un nuevo hilo..."
          rows={1}
          disabled={disabled || sending}
          className="w-full bg-transparent text-gray-900 text-[14px] sm:text-[15px] p-2 sm:p-3 min-h-[44px] max-h-32 outline-none resize-none placeholder:text-gray-400 disabled:opacity-50"
        />
        <button
          onClick={send}
          disabled={!text.trim() || sending || disabled}
          className="w-10 h-10 shrink-0 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:bg-gray-300 text-white rounded-xl flex items-center justify-center transition-all mb-0.5 shadow-sm"
          title="Enviar"
        >
          {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4 ml-0.5" />}
        </button>
      </div>
    </div>
  );
}
