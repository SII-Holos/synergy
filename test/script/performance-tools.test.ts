import { describe, expect, test } from "bun:test"

const requiredFiles = [
  "lighthouserc.performance.cjs",
  "packages/app/script/visualizer-report.ts",
  "script/performance-playwright.ts",
  "script/performance-benchmark.ts",
  "script/performance-hyperfine.sh",
  "script/performance-http.sh",
  "script/performance-k6.js",
]

describe("optional performance tooling integration", () => {
  test("keeps concrete OSS tool entrypoints in the repository", async () => {
    for (const path of requiredFiles) {
      expect(await Bun.file(path).exists()).toBe(true)
    }
  })

  test("documents k6 as optional and not a runtime dependency", async () => {
    const docs = await Bun.file("docs/operations/performance-observability.md").text()
    const rootPackage = await Bun.file("package.json").json()
    expect(docs).toContain("k6")
    expect(docs).toContain("not a runtime dependency")
    expect(JSON.stringify(rootPackage.dependencies ?? {})).not.toContain("k6")
  })
})
