import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { stagePackablePackage } from "../../../script/package-check"
import {
  createPublishablePackageJson,
  readCatalog,
  type PackageJson,
} from "../../../script/release/shared/package-manifest"

let tempRoot: string

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true })
})

async function makeFixturePackage(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tempRoot, "fixture-"))
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(dir, relativePath)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, content)
  }
  return dir
}

describe("stagePackablePackage", () => {
  test("packs a publishable manifest from a staged copy without touching the source tree", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "package-check-staging-"))
    const sourceJson: PackageJson = {
      name: "@example/fixture",
      version: "1.0.0",
      exports: {
        ".": {
          bun: "./src/index.ts",
          types: "./src/index.ts",
          import: "./dist/index.js",
        },
      },
      files: ["dist"],
      dependencies: { "@example/peer": "workspace:*" },
      devDependencies: { typescript: "catalog:" },
    }
    const sourceDir = await makeFixturePackage({
      "package.json": JSON.stringify(sourceJson, null, 2),
      "dist/index.js": "export const value = 1\n",
      "src/index.ts": "export const value = 1\n",
    })
    const before = await readFile(path.join(sourceDir, "package.json"), "utf8")

    const publishable = createPublishablePackageJson({
      packageJson: sourceJson,
      version: "1.0.0",
      catalog: await readCatalog(),
      dependencyVersions: { "@example/peer": "2.0.0" },
    })
    const tarball = await stagePackablePackage({ sourceDir, packageJson: publishable, tempDir: tempRoot })

    expect(await readFile(path.join(sourceDir, "package.json"), "utf8")).toBe(before)

    const extractDir = await mkdtemp(path.join(tempRoot, "extract-"))
    await Bun.$`tar -xzf ${tarball} -C ${extractDir}`
    const packedJson = JSON.parse(await readFile(path.join(extractDir, "package", "package.json"), "utf8"))
    expect(packedJson).toEqual(publishable)
    const packedFiles = (await Bun.$`tar -tzf ${tarball}`.text()).trim().split("\n")
    expect(packedFiles).toContain("package/dist/index.js")
    expect(packedFiles.some((file) => file === "package/src/index.ts")).toBe(false)
  })

  test("stages packages without a files field with their sources intact", async () => {
    tempRoot = (await mkdtemp(path.join(os.tmpdir(), "package-check-staging-"))) ?? tempRoot
    const sourceJson: PackageJson = {
      name: "@example/bare",
      version: "0.1.0",
      exports: {
        ".": {
          bun: "./src/index.ts",
          types: "./src/index.ts",
          import: "./dist/index.js",
        },
      },
    }
    const sourceDir = await makeFixturePackage({
      "package.json": JSON.stringify(sourceJson, null, 2),
      "src/index.ts": "export const value = 1\n",
      "tsconfig.json": "{}\n",
    })
    const before = await readFile(path.join(sourceDir, "package.json"), "utf8")

    const publishable = createPublishablePackageJson({
      packageJson: sourceJson,
      version: "0.1.0",
      catalog: {},
    })
    const tarball = await stagePackablePackage({ sourceDir, packageJson: publishable, tempDir: tempRoot })

    expect(await readFile(path.join(sourceDir, "package.json"), "utf8")).toBe(before)

    const packedFiles = (await Bun.$`tar -tzf ${tarball}`.text()).trim().split("\n")
    expect(packedFiles).toContain("package/src/index.ts")
    expect(packedFiles).toContain("package/tsconfig.json")
  })
})
