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
const sdkDistComplete =
  fs.existsSync(path.join(sdkRoot, "dist/index.js")) &&
  fs.existsSync(path.join(sdkRoot, "dist/client.js")) &&
  fs.existsSync(path.join(sdkRoot, "dist/server.js"))

// Check that all generated source files exist — partial/interrupted SDK
// generation (e.g. missing types.gen.ts or client.gen.ts) can break the
// frontend build. Only activate aliases when all critical gen files are present.
const sdkGenSourceExists =
  fs.existsSync(path.join(sdkRoot, "src/gen/sdk.gen.ts")) &&
  fs.existsSync(path.join(sdkRoot, "src/gen/types.gen.ts")) &&
  fs.existsSync(path.join(sdkRoot, "src/gen/client/client.gen.ts"))

/**
 * Fallback aliases for the SDK — only active when dist/ hasn't been built yet.
 * In production (where dist/ exists), Vite resolves normally via package.json exports.
 *
 * Evaluated once at Vite config load time. After generating the SDK dist/,
 * restart the dev server to switch back to normal package resolution.
 * @type {import("vite").Alias[]}
 */
const sdkAliases =
  sdkDistComplete || !sdkGenSourceExists
    ? []
    : [
        { find: /^@ericsanchezok\/synergy-sdk\/client$/, replacement: path.join(sdkRoot, "src/client.ts") },
        { find: /^@ericsanchezok\/synergy-sdk\/server$/, replacement: path.join(sdkRoot, "src/server.ts") },
        { find: /^@ericsanchezok\/synergy-sdk$/, replacement: path.join(sdkRoot, "src/index.ts") },
      ]

/**
 * @type {import("vite").PluginOption}
 */
export default [
  {
    name: "synergy-app:config",
    config() {
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
            ...sdkAliases,
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
