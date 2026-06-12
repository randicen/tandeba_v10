import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Proxy para OpenCode Zen. El browser puede llamar a /api/zen/* (mismo
      // origen, sin CORS) y Vite reenvía a https://opencode.ai/zen/*. Útil
      // para futuras llamadas LLM desde el frontend; hoy el backend usa la
      // misma config pero sin pasar por el proxy (server-side, no CORS).
      proxy: {
        '/api/zen': {
          target: 'https://opencode.ai/zen',
          changeOrigin: true,
          secure: true,
          rewrite: (path) => path.replace(/^\/api\/zen/, ''),
        },
      },
    },
  };
});
