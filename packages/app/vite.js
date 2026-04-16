import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "url"

const require = createRequire(import.meta.url)
const virtuaPackagePath = require.resolve("virtua/package.json")
const virtuaSolidEntry = path.join(path.dirname(virtuaPackagePath), "lib/solid/index.mjs")

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
