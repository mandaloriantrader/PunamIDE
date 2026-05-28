import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  server: {
    watch: {
      // Ignore non-source folders so Punam editing test files doesn't trigger HMR reload
      ignored: ['**/test-refactor/**', '**/files/**', '**/plans/**', '**/dist/**'],
    },
  },
})
