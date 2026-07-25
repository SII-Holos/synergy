import { describe, expect, test } from "bun:test"

const SOURCE_ROOTS = ["src", "../ui/src"]
const DIRECT_BROWSER_CRYPTO = /(?:(?:globalThis|window)\.)?crypto\??\.(?:randomUUID|getRandomValues)\b/g

async function browserSources() {
  const files: Array<{ path: string; source: string }> = []
  const glob = new Bun.Glob("**/*.{ts,tsx}")
  for (const root of SOURCE_ROOTS) {
    for await (const relativePath of glob.scan({ cwd: root })) {
      const path = `${root}/${relativePath}`
      files.push({ path, source: await Bun.file(path).text() })
    }
  }
  return files
}

describe("browser cryptography contract", () => {
  test("routes browser randomness through the shared utility boundary", async () => {
    const violations: string[] = []
    for (const { path, source } of await browserSources()) {
      for (const match of source.matchAll(DIRECT_BROWSER_CRYPTO)) {
        violations.push(`${path}: ${match[0]}`)
      }
    }
    expect(violations.sort()).toEqual([])
  })
})
