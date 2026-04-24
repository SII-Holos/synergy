import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "url"

const require = createRequire(import.meta.url)
const virtuaPackagePath = require.resolve("virtua/package.json")
const virtuaSolidEntry = path.join(path.dirname(virtuaPackagePath), "lib/solid/index.mjs")
const synergySdkSrc = fileURLToPath(new URL("../sdk/js/src/index.ts", import.meta.url))
const synergySdkClientSrc = fileURLToPath(new URL("../sdk/js/src/client.ts", import.meta.url))
const synergySdkServerSrc = fileURLToPath(new URL("../sdk/js/src/server.ts", import.meta.url))

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
              find: /^@ericsanchezok\/synergy-sdk$/,
              replacement: synergySdkSrc,
            },
            {
              find: /^@ericsanchezok\/synergy-sdk\/client$/,
              replacement: synergySdkClientSrc,
            },
            {
              find: /^@ericsanchezok\/synergy-sdk\/server$/,
              replacement: synergySdkServerSrc,
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
