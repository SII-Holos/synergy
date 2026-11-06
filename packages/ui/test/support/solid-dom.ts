import { plugin } from "bun"
import { transformAsync } from "@babel/core"
import { JSDOM } from "jsdom"
import solid from "babel-preset-solid"
import typescript from "@babel/preset-typescript"

export async function setupSolidDOM() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://example.test" })
  for (const key of [
    "window",
    "document",
    "Node",
    "Element",
    "HTMLElement",
    "HTMLButtonElement",
    "DOMParser",
    "MutationObserver",
  ] as const)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: key === "window" ? dom.window : dom.window[key],
    })
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
      build.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }))
    },
  })
  return () => dom.window.close()
}
