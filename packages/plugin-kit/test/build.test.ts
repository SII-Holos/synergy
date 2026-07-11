import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { PluginManifest } from "@ericsanchezok/synergy-plugin"
import { publishGeneration } from "../src/commands/dev"

describe("plugin build and dev generations", () => {
  test("generates a manifest, advances the pointer atomically, and retains the last good generation", async () => {
    const root = fs.mkdtempSync(path.join(import.meta.dir, "fixture-"))
    try {
      fs.mkdirSync(path.join(root, "src"), { recursive: true })
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({
          name: "build-fixture",
          version: "1.0.0",
          type: "module",
          source: "./src/index.ts",
        }),
      )
      const source = path.join(root, "src", "index.ts")
      fs.writeFileSync(
        source,
        `
import { definePlugin, operation } from "@ericsanchezok/synergy-plugin"
export default definePlugin({
  id: "build-fixture",
  version: "1.0.0",
  description: "Build fixture",
  contributions: [operation({
    id: "ping",
    type: "query",
    input: { type: "object" },
    output: { type: "object" },
    handler: async () => ({ pong: true }),
  })],
})
`,
      )
      expect(fs.existsSync(path.join(root, "plugin.json"))).toBe(false)
      expect(await publishGeneration(root)).toBe(true)
      const pointerPath = path.join(root, "dist", "dev", "current.json")
      const current = fs.readFileSync(pointerPath, "utf-8")
      const pointer = JSON.parse(current)
      const manifest = PluginManifest.parse(
        JSON.parse(fs.readFileSync(path.join(pointer.directory, "plugin.json"), "utf-8")),
      )
      expect(manifest.id).toBe("build-fixture")
      expect(manifest.contributions).toHaveLength(1)
      expect(manifest.artifacts.runtime?.entry).toBe("runtime/index.js")

      fs.writeFileSync(source, "export default @")
      expect(await publishGeneration(root)).toBe(false)
      expect(fs.readFileSync(pointerPath, "utf-8")).toBe(current)
      expect(fs.existsSync(pointer.directory)).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
