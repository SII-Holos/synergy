import { transformAsync, type PresetTarget } from "@babel/core"
import type { BunPlugin, Loader } from "bun"

const solidPreset = require("babel-preset-solid") as PresetTarget

export function solidCompilerPlugin(): BunPlugin {
  return {
    name: "synergy-solid-compiler",
    setup(builder) {
      builder.onLoad({ filter: /\.[jt]sx$/ }, async ({ path }) => {
        const typescript = path.endsWith(".tsx")
        const result = await transformAsync(await Bun.file(path).text(), {
          filename: path,
          babelrc: false,
          configFile: false,
          parserOpts: { plugins: typescript ? ["typescript", "jsx"] : ["jsx"] },
          presets: [[solidPreset, { generate: "dom", hydratable: false, development: false }]],
          sourceMaps: "inline",
        })
        if (!result?.code) throw new Error(`Solid compiler produced no output: ${path}`)
        return { contents: result.code, loader: (typescript ? "ts" : "js") as Loader }
      })
    },
  }
}
