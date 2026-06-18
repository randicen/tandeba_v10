// ChatScreen.tsx — Pantalla #2 del mundo (la del medio).
//
// El chat ocupa toda la pantalla, sin sidebar. Se ve el greeting, el
// mensaje del usuario, los tool calls, la tabla de sentencias y el
// composer al fondo. Es la "pantalla de conversación" ampliada — la más
// representativa de Worgena en uso.

import { WORGENA_W, WORGENA_H, Topbar, ChatArea } from "../ui/WorgenaUI";

export function ChatScreen() {
  return (
    <div
      className="flex flex-col bg-white text-gray-900 font-sans overflow-hidden rounded-xl shadow-[0_8px_40px_rgba(0,0,0,0.4)]"
      style={{ width: WORGENA_W, height: WORGENA_H }}
    >
      <Topbar />
      <ChatArea />
    </div>
  );
}
