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
  build: {
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Group async-loaded page components to avoid too many tiny chunks.
          if (id.includes('src/components/viewer/')) return 'chunk-viewers'
          if (
            id.includes('src/views/SelfImageView.vue') ||
            id.includes('src/views/UserProfileView.vue') ||
            id.includes('src/components/ActionCenter.vue') ||
            id.includes('src/components/ActionEdit.vue') ||
            id.includes('src/components/AgentEdit.vue') ||
            id.includes('src/components/ComputeCenter.vue') ||
            id.includes('src/components/CommissionCenter.vue') ||
            id.includes('src/components/ApprovalLog.vue')
          ) {
            return 'chunk-pages'
          }

          if (id.includes('node_modules')) {
            if (id.includes('@pixiv/three-vrm')) return 'chunk-vrm'
            if (id.includes('/three/')) return 'chunk-three'
            if (id.includes('@tauri-apps')) return 'chunk-tauri'
            if (
              id.includes('highlight.js') ||
              id.includes('marked') ||
              id.includes('dompurify')
            ) {
              return 'chunk-markdown'
            }
            if (id.includes('live2d')) return 'chunk-live2d'
            if (id.includes('vue') || id.includes('pinia')) return 'chunk-vendor'
          }
        },
      },
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
        changeOrigin: true,
      },
      '/api': {
        target: 'http://127.0.0.1:8848',
        changeOrigin: true,
      },
      '/uploads': {
        target: 'http://127.0.0.1:8848',
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 4173,
    strictPort: true,
    host: '0.0.0.0',
    proxy: {
      '/api/v1/ws': {
        target: 'ws://127.0.0.1:8848',
        ws: true,
        changeOrigin: true,
      },
      '/api': {
        target: 'http://127.0.0.1:8848',
        changeOrigin: true,
      },
      '/uploads': {
        target: 'http://127.0.0.1:8848',
        changeOrigin: true,
      },
    },
  },
})
