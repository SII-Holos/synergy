import { describe, expect, test } from "bun:test"
import path from "node:path"
import {
  createPublishablePackageJson,
  readCatalog,
  type PackageJson,
} from "../../../script/release/shared/package-manifest"

const repoRoot = path.resolve(import.meta.dir, "../../..")

describe("publishable package manifest", () => {
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
