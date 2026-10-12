import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Local loop: a control-plane on 3000 started with APP_ORIGIN=http://localhost:5173, so the
  // browser's own Origin passes the check and the cookie stays first party. /api/chat is listed
  // first because Vite takes the first matching prefix; the agent on 3100 needs the same APP_ORIGIN.
  server: {
    port: 5173,
    proxy: { '/api/chat': 'http://127.0.0.1:3100', '/api': 'http://127.0.0.1:3000' },
  },
});
