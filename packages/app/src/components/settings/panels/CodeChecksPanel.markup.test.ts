import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("CodeChecksPanel markup", () => {
  test("exposes an accessible post-write diagnostics switch", () => {
    const source = readFileSync(join(import.meta.dir, "CodeChecksPanel.tsx"), "utf8")
    expect(source).toContain('title="LSP diagnostics after edits"')
    expect(source).toContain("<Switch")
    expect(source).not.toMatch(/<label[^>]*>[\s\S]*<Switch/)
  })
})
