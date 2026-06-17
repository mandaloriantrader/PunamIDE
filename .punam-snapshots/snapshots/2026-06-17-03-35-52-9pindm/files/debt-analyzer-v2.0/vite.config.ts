import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],

  optimizeDeps: {
    // web-tree-sitter uses WebAssembly.instantiateStreaming internally.
    // Vite's dep optimizer wraps modules in a way that breaks WASM loading —
    // exclude it so it's loaded as-is from node_modules.
    exclude: ['web-tree-sitter'],
  },

  worker: {
    // Debt analyzer worker uses ES module syntax and ?url imports.
    // Must match the { type: "module" } passed to new Worker().
    format: 'es',
  },

  build: {
    rollupOptions: {
      output: {
        // Keep WASM files as separate assets (never inline).
        // Vite's default 4KB inlineLimit won't affect ~1–2MB WASM files,
        // but this makes the intent explicit for future config changes.
        assetFileNames: (assetInfo) => {
          if (assetInfo.name?.endsWith('.wasm')) {
            return 'assets/wasm/[name]-[hash][extname]'
          }
          return 'assets/[name]-[hash][extname]'
        },
      },
    },
  },
})
