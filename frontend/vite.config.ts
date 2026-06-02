import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: '0.0.0.0',
    proxy: {
      // WS must be BEFORE the generic /api prefix
      '/api/v1/ws': {
        target: 'ws://127.0.0.1:8848',
        ws: true,
      },
      '/api': 'http://127.0.0.1:8848',
      '/uploads': 'http://127.0.0.1:8848',
    },
  },
})
