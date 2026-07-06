import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    // In-tree default (desktop/package.json bundles app/dist as the
    // packaged frontend). Sandbox builds pass --outDir /tmp/… instead —
    // the in-tree dist/ errors on permissions there.
    outDir: 'dist',
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3456',
        changeOrigin: true,
      },
    },
  },
})
