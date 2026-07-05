import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import path from "node:path"
import fs from "node:fs"
import { createRequire } from "node:module"
import { fileURLToPath } from "url"

const require = createRequire(import.meta.url)
const virtuaPackagePath = require.resolve("virtua/package.json")
const virtuaSolidEntry = path.join(path.dirname(virtuaPackagePath), "lib/solid/index.mjs")

const sdkRoot = path.resolve(fileURLToPath(new URL("../sdk/js", import.meta.url)))
const pluginRoot = path.resolve(fileURLToPath(new URL("../plugin", import.meta.url)))
const pluginDistComplete =
  fs.existsSync(path.join(pluginRoot, "dist/index.js")) &&
  fs.existsSync(path.join(pluginRoot, "dist/artifact.js")) &&
  fs.existsSync(path.join(pluginRoot, "dist/ids.js")) &&
  fs.existsSync(path.join(pluginRoot, "dist/permissions.js"))

const sdkGenSourceExists =
  fs.existsSync(path.join(sdkRoot, "src/gen/sdk.gen.ts")) &&
  fs.existsSync(path.join(sdkRoot, "src/gen/types.gen.ts")) &&
  fs.existsSync(path.join(sdkRoot, "src/gen/client/client.gen.ts"))

/**
 * Always resolve the workspace SDK from its TypeScript sources when they exist,
 * for both `serve` (dev) and `build` (production). The compiled `dist/` is a
 * gitignored build artifact that easily lags `src/gen` (e.g. after the OpenAPI
 * client is regenerated but dist isn't rebuilt), which silently drops newly
 * added request fields from the bundled client. Compiling from source removes
 * that entire class of stale-dist bugs; falls back to the published dist only
 * when sources are absent (e.g. a packaged install).
 *
 * @returns {import("vite").Alias[]}
 */
function sdkAliases() {
  if (!sdkGenSourceExists) return []
  return [
    { find: /^@ericsanchezok\/synergy-sdk\/client$/, replacement: path.join(sdkRoot, "src/client.ts") },
    { find: /^@ericsanchezok\/synergy-sdk\/server$/, replacement: path.join(sdkRoot, "src/server.ts") },
    { find: /^@ericsanchezok\/synergy-sdk$/, replacement: path.join(sdkRoot, "src/index.ts") },
  ]
}

const pluginAliases = pluginDistComplete
  ? []
  : [{ find: /^@ericsanchezok\/synergy-plugin\/([^/]+)$/, replacement: path.join(pluginRoot, "src/$1.ts") }]

/**
 * @type {import("vite").PluginOption}
 */
export default [
  {
    name: "synergy-app:config",
    config(_config, _env) {
      return {
        resolve: {
          alias: [
            {
              find: /^virtua\/solid$/,
              replacement: virtuaSolidEntry,
            },
            {
              find: "@",
              replacement: fileURLToPath(new URL("./src", import.meta.url)),
            },
            ...sdkAliases(),
            ...pluginAliases,
          ],
        },
        worker: {
          format: "es",
        },
      }
    },
  },
  tailwindcss(),
  solidPlugin(),
]
