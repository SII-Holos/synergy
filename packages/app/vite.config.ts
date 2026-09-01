import { defineConfig, type PluginOption } from "vite"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import appPlugin from "./vite"
import pkg from "./package.json"
import { resolveAppBuildIdentity } from "./script/build-identity"

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

function gitOutput(args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      // Avoid contending with concurrent git operations (e.g. watchers) for
      // the index lock during config load.
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    }).trim()
  } catch {
    return undefined
  }
}

export default defineConfig(async ({ command }) => {
  const sourceBuild = process.env.SYNERGY_APP_BUILD_KIND === "local"
  const local = command === "serve" || sourceBuild
  const buildIdentity = resolveAppBuildIdentity({
    command,
    sourceBuild,
    packageVersion: pkg.version,
    revision: local ? gitOutput(["rev-parse", "HEAD"]) : undefined,
    dirty: local ? Boolean(gitOutput(["status", "--short", "--untracked-files=normal"])) : undefined,
  })

  return {
    base: "./",
    plugins: [appPlugin, ...(await performanceVisualizer())] as PluginOption[],
    define: {
      "import.meta.env.VITE_SYNERGY_BUILD_LABEL": JSON.stringify(buildIdentity.label),
    },
    resolve: {
      alias: {
        // Tiptap 3.27.2's blockquote bundle inlines prosemirror-model, creating a second Fragment identity.
        "@tiptap/extension-blockquote": fileURLToPath(
          new URL("./src/components/note/blockquote-extension.ts", import.meta.url),
        ),
      },
      dedupe: ["prosemirror-model"],
    },
    server: {
      host: "0.0.0.0",
      allowedHosts: true,
      port: 3000,
      proxy: {
        "/plugin": {
          target: synergyServerUrl,
          changeOrigin: true,
        },
        // The file workbench HTML preview frames /workspace/files/raw/... from
        // the app origin (X-Frame-Options: SAMEORIGIN), so bun dev must proxy
        // these through Vite when the server runs on another port.
        "/workspace": {
          target: synergyServerUrl,
          changeOrigin: true,
        },
      },
    },
    build: {
      target: "esnext",
      sourcemap: buildIdentity.sourcemap,
      rollupOptions: {
        output: {
          manualChunks(id: string) {
            if (id.includes("node_modules/solid-js") || id.includes("node_modules/@solidjs")) return "vendor-solid"
            if (id.includes("node_modules/marked")) return "vendor-markdown"
            if (id.includes("node_modules/katex")) return "vendor-katex"
            if (id.includes("node_modules/chart.js")) return "vendor-chart"
          },
        },
      },
    },
  }
})
