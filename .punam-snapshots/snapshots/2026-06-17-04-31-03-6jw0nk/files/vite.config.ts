import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],

  optimizeDeps: {
    // web-tree-sitter uses WebAssembly.instantiateStreaming internally.
    // Vite's dep optimizer wraps modules in a way that breaks WASM loading.
    exclude: ['web-tree-sitter'],
  },

  worker: {
    // Debt analyzer worker uses ES module syntax and ?url imports.
    format: 'es',
  },

  build: {
    rollupOptions: {
      output: {
        // Keep WASM files in a stable location — ?url imports in ASTEngine.ts
        // resolve to these paths at build time. Hashing is fine; the ?url
        // import captures the hashed name automatically.
        assetFileNames: (assetInfo) => {
          if (assetInfo.name?.endsWith('.wasm')) {
            return 'assets/wasm/[name][extname]'   // no hash — stable URL for worker context
          }
          return 'assets/[name]-[hash][extname]'
        },
      },
    },
  },
})
