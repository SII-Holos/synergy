import fs from "node:fs"
import path from "node:path"
import type { BunPlugin } from "bun"
import { sha256File } from "./crypto.js"

export function createUIAssetPlugin(outputDirectory: string) {
  const outputs = new Set<string>()
  const extensions = /\.(woff2?|ttf|otf|png|jpe?g|webp|avif|svg)$/i
  const plugin: BunPlugin = {
    name: "synergy-ui-assets",
    setup(builder) {
      builder.onResolve({ filter: extensions }, (input) => {
        if (input.kind === "url-token" || input.kind === "import-rule") return
        const file =
          input.path.startsWith(".") || path.isAbsolute(input.path)
            ? path.resolve(input.resolveDir, input.path)
            : Bun.resolveSync(input.path, input.resolveDir)
        return { path: file, namespace: "synergy-ui-asset" }
      })
      builder.onLoad({ filter: /.*/, namespace: "synergy-ui-asset" }, (input) => {
        const digest = sha256File(input.path)
        const name = `${digest}${path.extname(input.path).toLowerCase()}`
        const output = path.join(outputDirectory, "assets", name)
        fs.mkdirSync(path.dirname(output), { recursive: true })
        if (!outputs.has(output)) fs.copyFileSync(input.path, output)
        outputs.add(output)
        return {
          contents: `export default new URL(${JSON.stringify(`./assets/${name}`)}, import.meta.url).href`,
          loader: "js",
        }
      })
    },
  }
  return { plugin, outputs }
}
