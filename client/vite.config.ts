import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    allowedHosts: ['seans-mac-mini.tail4b4f99.ts.net'],
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:3002',
      '/assets': 'http://127.0.0.1:3002'
    }
  }
})
