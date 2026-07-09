import { defineConfig, type PluginOption } from "vite"
import appPlugin from "./vite"

const synergyServerUrl = process.env.VITE_SYNERGY_SERVER_URL ?? "http://localhost:4096"

async function performanceVisualizer(): Promise<PluginOption[]> {
  if (process.env.SYNERGY_BUNDLE_VISUALIZER !== "1") return []
  try {
    const importer = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<{
      visualizer: (options: {
        filename: string
        template: string
        gzipSize: boolean
        brotliSize: boolean
      }) => PluginOption
    }>
    const { visualizer } = await importer("rollup-plugin-visualizer")
    return [
      visualizer({
        filename: process.env.SYNERGY_BUNDLE_REPORT ?? "dist/performance/bundle-visualizer.html",
        template: process.env.SYNERGY_BUNDLE_REPORT_MODE ?? "treemap",
        gzipSize: true,
        brotliSize: true,
      }),
    ]
  } catch {
    throw new Error("SYNERGY_BUNDLE_VISUALIZER=1 requires optional dev dependency rollup-plugin-visualizer")
  }
}

export default defineConfig({
  base: "./",
  plugins: [appPlugin, ...(await performanceVisualizer())] as PluginOption[],
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    port: 3000,
    proxy: {
      "/plugin": {
        target: synergyServerUrl,
        changeOrigin: true,
      },
    },
  },
  build: {
    target: "esnext",
    rollupOptions: {
      output: {
        manualChunks(id: string) {
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
