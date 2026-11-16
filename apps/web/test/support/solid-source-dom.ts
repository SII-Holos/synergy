import { plugin } from "bun"
import path from "node:path"
import { createCompiledCatalog } from "@lingui/cli/api"
import linguiConfig from "../../lingui.config"
import { transformAsync } from "@babel/core"
import solid from "babel-preset-solid"
import typescript from "@babel/preset-typescript"

export async function setupSolidSourceDOM() {
  if (!document.doctype)
    document.insertBefore(document.implementation.createDocumentType("html", "", ""), document.documentElement)
  const sourceLocale = linguiConfig.sourceLocale
  if (!sourceLocale) throw new Error("Source rendering requires the configured source locale")
  await plugin({
    name: "solid-dom-source-coverage",
    setup(build) {
      build.onLoad({ filter: /\.tsx$/ }, async ({ path }) => ({
        contents: (await transformAsync(await Bun.file(path).text(), {
          filename: path,
          parserOpts: { plugins: ["jsx"] },
          presets: [
            [solid, { generate: "dom" }],
            [typescript, { ignoreExtensions: true, onlyRemoveTypeImports: false }],
          ],
          sourceMaps: "inline",
        }))!.code!,
        loader: "js",
      }))
      build.onLoad({ filter: /\.po(?:\?lingui)?$/ }, async ({ path: filename }) => {
        const file = filename.replace(/\?lingui$/, "")
        const locale = path.basename(path.dirname(file))
        const format = linguiConfig.format
        if (!format || typeof format !== "object" || typeof format.parse !== "function")
          throw new Error("Source rendering requires the configured Lingui catalog formatter")
        const catalog = await format.parse(await Bun.file(file).text(), {
          locale,
          sourceLocale,
          filename: file,
        })
        const compiled = createCompiledCatalog(
          locale,
          Object.fromEntries(
            Object.entries(catalog)
              .filter(([, value]) => !value.obsolete)
              .map(([id, value]) => [id, value.translation || value.message || id]),
          ),
          { namespace: linguiConfig.compileNamespace },
        )
        if (compiled.errors.length)
          throw new AggregateError(
            compiled.errors.map((error) => error.error),
            "Source catalog compilation failed",
          )
        return { contents: compiled.source, loader: "js" }
      })
      build.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }))
    },
  })
}
