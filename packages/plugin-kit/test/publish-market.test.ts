import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { assertMarketplaceNaming } from "../src/commands/publish-market"

describe("marketplace artifact naming", () => {
  test("uses the plugin id for package and artifact identity while allowing a display name", () => {
    const root = fs.mkdtempSync(path.join(import.meta.dir, "publish-market-fixture-"))
    try {
      const staging = path.join(root, "payload")
      fs.mkdirSync(staging)
      fs.writeFileSync(path.join(staging, "package.json"), JSON.stringify({ name: "fixture-plugin" }))
      const tarballPath = path.join(root, "fixture-plugin-1.0.0.synergy-plugin.tgz")
      const packed = Bun.spawnSync(["tar", "-czf", tarballPath, "-C", staging, "."])
      expect(packed.exitCode).toBe(0)

      expect(() =>
        assertMarketplaceNaming({
          tarballPath,
          manifest: {
            id: "fixture-plugin",
            name: "Fixture Plugin",
            version: "1.0.0",
          },
        }),
      ).not.toThrow()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
