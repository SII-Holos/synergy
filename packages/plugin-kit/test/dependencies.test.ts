import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

describe("plugin-kit runtime dependencies", () => {
  test("installs Babel's TypeScript preset for standalone bundles", () => {
    const packageJson = path.resolve(import.meta.dir, "../node_modules/@babel/preset-typescript/package.json")
    expect(fs.existsSync(packageJson)).toBe(true)
  })
})
