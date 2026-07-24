import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { pathToFileURL } from "url"

describe("plugin definition loader", () => {
  test("loads definitions from the compiled packaged loader", async () => {
    const parent = fs.mkdtempSync(path.join(import.meta.dir, "definition-packaged-"))
    const root = path.join(parent, "plugin")
    try {
      fs.mkdirSync(path.join(root, "src"), { recursive: true })
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ source: "src/index.ts" }))
      fs.writeFileSync(
        path.join(root, "src", "index.ts"),
        'import { definePlugin } from "@ericsanchezok/synergy-plugin"\nexport default definePlugin({ id: "loader-packaged", version: "1.0.0", name: "Loader Packaged", description: "Packaged loader fixture", contributions: [] })\n',
      )

      const compiledDefinition = pathToFileURL(path.resolve(import.meta.dir, "../dist/lib/definition.js")).toString()
      const { loadPluginDefinition } = (await import(compiledDefinition)) as typeof import("../src/lib/definition")
      const result = await loadPluginDefinition(root)

      expect(result.definition.id).toBe("loader-packaged")
      expect(result.definition.version).toBe("1.0.0")
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })
})
