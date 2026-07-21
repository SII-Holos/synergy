import { describe, expect, test } from "bun:test"
import { THEME_TOKEN_SET } from "@ericsanchezok/synergy-ui/theme"

const SOURCE_ROOTS = ["src", "../ui/src", "../desktop/src"]
const GENERATED_FILES = new Set([
  "../ui/src/styles/theme.generated.css",
  "../ui/src/styles/tailwind/colors.css",
  "../desktop/src/default-shell-skin.generated.ts",
])
const COLOR_BOUNDARY_FILES = new Set([
  "../ui/src/theme/color.ts",
  "../ui/src/theme/resolve.ts",
  "../ui/src/theme/schema-contract.ts",
])
const PRECISE_EXCEPTIONS: Record<string, RegExp[]> = {
  "src/components/workspace/browser/annotation-input.tsx": [/placeholder="#3b82f6"/g],
  "../desktop/src/browser-webrtc-host.ts": [/background:#111/g],
  "../ui/src/components/list.css": [/#(?:ffff|0000)\b/g],
  "../ui/src/components/dag-graph.css": [/#000(?=\s+52%)/g],
}
const COLOR_CLASS =
  /\b(?:bg|text|border|ring|fill|stroke)-((?:background|surface|text|border|icon|button|input|syntax|markdown|avatar|chart)(?:-[a-z0-9-]+)?)(?:\/[0-9.]+)?\b/g
const LEGACY_PALETTE_CLASS =
  /(?<![a-z0-9-])(?:bg|text|border|ring|fill|stroke)-(?:black|white|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)(?:-[0-9]+)?(?:\/[0-9.]+)?\b/g
const ARBITRARY_COLOR_CLASS = /(?<![a-z0-9-])(?:bg|text|border|ring|fill|stroke)-\[(?:#|rgba?\(|hsla?\()/g
const PRODUCT_COLOR = /#[0-9a-fA-F]{3,8}\b|(?:rgb|rgba|hsl|hsla)\(\s*(?:\d|#)/g
const BLACK_WHITE_MIX = /color-mix\([^)]*\b(?:black|white)\b[^)]*\)/g
const NAMED_PRODUCT_COLOR =
  /(?:^|[;{]\s*)(?:color|background(?:-color)?|border-color|fill|stroke)\s*:\s*(?:black|white)\b/gm
const FIXED_THIRD_PARTY_THEME = /["'](?:github-light|github-dark)["']|theme\s*:\s*["']neutral["']/g

function withoutComments(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1")
    .replace(/&#[0-9]+;/g, "")
}

function productionSource(path: string, source: string) {
  let result = source
  if (path === "index.html") {
    result = result.replace(/\/\* BEGIN GENERATED SKIN FALLBACK \*\/[\s\S]*?\/\* END GENERATED SKIN FALLBACK \*\//, "")
    result = result.replace(/<meta id="synergy-theme-color" name="theme-color" content="#[0-9a-fA-F]+" \/>/, "")
  }
  result = withoutComments(result)
  for (const exception of PRECISE_EXCEPTIONS[path] ?? []) result = result.replace(exception, "")
  return result
}

async function sourceFiles() {
  const files: Array<{ path: string; source: string }> = []
  const glob = new Bun.Glob("**/*.{css,ts,tsx}")
  for (const root of SOURCE_ROOTS) {
    for await (const relativePath of glob.scan({ cwd: root })) {
      const path = `${root}/${relativePath}`
      if (path.includes(".test.") || GENERATED_FILES.has(path) || COLOR_BOUNDARY_FILES.has(path)) continue
      files.push({ path, source: productionSource(path, await Bun.file(path).text()) })
    }
  }
  files.push({ path: "index.html", source: productionSource("index.html", await Bun.file("index.html").text()) })
  return files
}

describe("frontend color token contract", () => {
  test("semantic color utilities resolve through the canonical theme", async () => {
    const invalid = new Set<string>()
    for (const { path, source } of await sourceFiles()) {
      for (const match of source.matchAll(COLOR_CLASS)) {
        const token = match[1]
        if (!THEME_TOKEN_SET.has(token)) invalid.add(`${path}: ${match[0]}`)
      }
    }
    expect([...invalid].sort()).toEqual([])
  })

  test("App, UI, and Desktop production sources do not bypass the semantic color contract", async () => {
    const invalid: string[] = []
    for (const { path, source } of await sourceFiles()) {
      for (const pattern of [
        LEGACY_PALETTE_CLASS,
        ARBITRARY_COLOR_CLASS,
        PRODUCT_COLOR,
        BLACK_WHITE_MIX,
        NAMED_PRODUCT_COLOR,
        FIXED_THIRD_PARTY_THEME,
      ]) {
        for (const match of source.matchAll(pattern)) invalid.push(`${path}: ${match[0]}`)
      }
      if (/styles\/colors\.css|var\(--(?:white|black|gray|slate|red)-?/.test(source)) {
        invalid.push(`${path}: legacy palette reference`)
      }
    }
    expect(invalid.sort()).toEqual([])
  })

  test("the retired palette cannot be reintroduced", async () => {
    expect(await Bun.file("../ui/src/styles/colors.css").exists()).toBe(false)
  })
})
