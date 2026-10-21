import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

/** Production-only CSP: the dev server needs inline scripts for HMR. */
function cspPlugin() {
  return {
    name: 'berry-csp',
    apply: 'build' as const,
    transformIndexHtml(html: string) {
      const csp =
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'"
      return html.replace('</head>', `    <meta http-equiv="Content-Security-Policy" content="${csp}" />\n  </head>`)
    },
  }
}

export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react(), cspPlugin()],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
      '@': fileURLToPath(new URL('./src/renderer', import.meta.url)),
    },
  },
  build: {
    outDir: fileURLToPath(new URL('./dist/renderer', import.meta.url)),
    emptyOutDir: true,
    target: 'chrome126',
    sourcemap: false,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
})
