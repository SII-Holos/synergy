import { expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const css = await Bun.file(new URL("../src/index.css", import.meta.url)).text()
const appSrc = fileURLToPath(new URL("../src", import.meta.url))
const uiSrc = fileURLToPath(new URL("../../../packages/ui/src", import.meta.url))

function walkSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const filepath = join(dir, entry.name)
    if (entry.isDirectory()) return walkSourceFiles(filepath)
    if (!/\.(css|ts|tsx)$/.test(filepath)) return []
    try {
      return statSync(filepath).isFile() ? [filepath] : []
    } catch {
      return []
    }
  })
}

function escapeClassName(className: string) {
  return `.${className.replace(/:/g, "\\:").replace(/\//g, "\\/")}`
}

test("generic surface utilities used by the frontend are covered by workbench mappings", () => {
  const sourceFiles = [...walkSourceFiles(appSrc), ...walkSourceFiles(uiSrc)]
  const genericBgClass = /(?:^|[\s"'`])((?:hover:)?bg-(?:surface|background|input|button)-[A-Za-z0-9\-/]+)/g
  const semanticState =
    /success|warning|critical|info|diff|action|brand|overlay|interactive-solid|interactive-weak|interactive-hover|muted|disabled/
  const missing = new Set<string>()

  for (const filepath of sourceFiles) {
    const source = readFileSync(filepath, "utf8")
    let match: RegExpExecArray | null
    while ((match = genericBgClass.exec(source))) {
      const className = match[1]
      if (semanticState.test(className)) continue
      const selector = escapeClassName(className)
      if (css.includes(selector) || css.includes(`${selector}:hover`)) continue
      missing.add(className)
    }
  }

  expect([...missing].sort()).toEqual([])
})
