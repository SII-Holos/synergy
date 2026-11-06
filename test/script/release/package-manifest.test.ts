import { describe, expect, test } from "bun:test"
import path from "node:path"
import {
  createPublishablePackageJson,
  readCatalog,
  type PackageJson,
} from "../../../script/release/shared/package-manifest"

const repoRoot = path.resolve(import.meta.dir, "../../..")

describe("publishable package manifest", () => {
  test("versions component metadata and its first-party requirements with the published module", () => {
    const pkg: PackageJson = {
      name: "@ericsanchezok/synergy-mcp",
      version: "1.0.0",
      synergy: {
        formatVersion: 1,
        kind: "component",
        id: "mcp",
        version: "1.0.0",
        compatibility: { synergy: "1.0.0" },
        apiVersion: 1,
        entry: "./dist/component.js",
        export: "mcp",
        requires: { "local-runtime": "1.0.0" },
        packages: { "@ericsanchezok/synergy-note": "1.0.0" },
      },
    }
    const published = createPublishablePackageJson({ packageJson: pkg, version: "2.0.0", catalog: {} })
    expect(published.version).toBe("2.0.0")
    expect(published.synergy).toMatchObject({
      version: "2.0.0",
      compatibility: { synergy: "2.0.0" },
      requires: { "local-runtime": "2.0.0" },
      packages: { "@ericsanchezok/synergy-note": "2.0.0" },
    })
    expect(pkg.version).toBe("1.0.0")
  })
  test.each([
    ["plugin", { ".": "./src/index.ts", "./theme": "./src/theme/index.ts" }],
    [
      "plugin-kit",
      {
        ".": "./src/index.ts",
        "./commands": "./src/commands/index.ts",
        "./market-entry": "./src/lib/market-entry.ts",
      },
    ],
  ] as const)(
    "keeps %s source types resolvable and publishes dist declarations",
    async (packageName, expectedSourceTypes) => {
      const packageJson = (await Bun.file(
        path.join(repoRoot, `packages/${packageName}/package.json`),
      ).json()) as PackageJson
      const sourceExports = packageJson.exports as Record<string, { bun: string; types: string; import: string }>

      for (const [exportName, sourceType] of Object.entries(expectedSourceTypes)) {
        expect(sourceExports[exportName]?.types).toBe(sourceType)
      }

      const publishable = createPublishablePackageJson({
        packageJson,
        version: "3.0.11",
        catalog: await readCatalog(),
      })
      const publishedExports = publishable.exports as Record<string, { types: string; import: string }>

      for (const [exportName, sourceType] of Object.entries(expectedSourceTypes)) {
        const distBase = sourceType.replace("./src/", "./dist/").replace(/\.ts$/, "")
        expect(publishedExports[exportName]).toEqual({
          types: `${distBase}.d.ts`,
          import: `${distBase}.js`,
        })
        expect(sourceExports[exportName]?.types).toBe(sourceType)
      }
    },
  )
})
