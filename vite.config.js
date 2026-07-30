import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/jira': {
        target: 'https://kkvideo.atlassian.net',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/jira/, ''),
      },
    },
  },
})
