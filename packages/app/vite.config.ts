import { defineConfig } from "vite"
import appPlugin from "./vite"

export default defineConfig({
  base: "./",
  plugins: [appPlugin] as any,
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    port: 3000,
  },
  build: {
    target: "esnext",
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/solid-js") || id.includes("node_modules/@solidjs")) return "vendor-solid"
          if (id.includes("node_modules/marked") || id.includes("node_modules/shiki")) return "vendor-markdown"
          if (id.includes("node_modules/mermaid")) return "vendor-mermaid"
          if (id.includes("node_modules/katex")) return "vendor-katex"
          if (id.includes("node_modules/@tiptap")) return "vendor-tiptap"
          if (id.includes("node_modules/chart.js")) return "vendor-chart"
        },
      },
    },
    // sourcemap: true,
  },
})
