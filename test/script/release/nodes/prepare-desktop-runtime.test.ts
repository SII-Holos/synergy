import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { prepareRuntimeCoreAssets } from "../../../../script/release/shared/runtime-assets"
import { desktopRuntimePackageNames } from "../../../../script/release/prepare-desktop-runtime"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  )
})

describe("Desktop release runtime preparation", () => {
  test("copies the Web application and schema into the runtime layout", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-desktop-runtime-"))
    temporaryDirectories.push(root)
    const appDistDir = path.join(root, "app-dist")
    const runtimeDir = path.join(root, "runtime")
    const schemaPath = path.join(root, "config.schema.json")
    const playwrightCoreDir = path.join(root, "playwright-core")

    await fs.mkdir(path.join(appDistDir, "assets"), { recursive: true })
    await fs.mkdir(path.join(playwrightCoreDir, "lib"), { recursive: true })
    await fs.writeFile(path.join(appDistDir, "index.html"), "<!doctype html><main>Synergy</main>")
    await fs.writeFile(path.join(appDistDir, "assets", "app.js"), "export {}")
    await fs.writeFile(schemaPath, '{"type":"object"}')
    await fs.writeFile(path.join(playwrightCoreDir, "package.json"), '{"name":"playwright-core"}')
    await fs.writeFile(path.join(playwrightCoreDir, "index.js"), "module.exports = {}")
    await fs.writeFile(path.join(playwrightCoreDir, "lib", "coreBundle.js"), "module.exports = {}")

    await prepareRuntimeCoreAssets({ runtimeDir, appDistDir, schemaPath, playwrightCoreDir })

    expect(await Bun.file(path.join(runtimeDir, "app", "index.html")).text()).toContain("Synergy")
    expect(await Bun.file(path.join(runtimeDir, "app", "assets", "app.js")).text()).toBe("export {}")
    expect(await Bun.file(path.join(runtimeDir, "schema", "config.schema.json")).json()).toEqual({ type: "object" })
    expect(await Bun.file(path.join(runtimeDir, "browser-runtime", "playwright-core", "package.json")).json()).toEqual({
      name: "playwright-core",
    })
    expect(
      await Bun.file(path.join(runtimeDir, "browser-runtime", "playwright-core", "lib", "coreBundle.js")).text(),
    ).toBe("module.exports = {}")
  })

  test("replaces stale Web assets when runtime preparation is repeated", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-desktop-runtime-repeat-"))
    temporaryDirectories.push(root)
    const appDistDir = path.join(root, "app-dist")
    const runtimeDir = path.join(root, "runtime")
    const schemaPath = path.join(root, "config.schema.json")

    await fs.mkdir(appDistDir, { recursive: true })
    await fs.writeFile(path.join(appDistDir, "index.html"), "first")
    await fs.writeFile(schemaPath, "{}")
    await prepareRuntimeCoreAssets({ runtimeDir, appDistDir, schemaPath })
    await fs.writeFile(path.join(runtimeDir, "app", "stale.js"), "stale")
    await fs.writeFile(path.join(appDistDir, "index.html"), "second")

    await prepareRuntimeCoreAssets({ runtimeDir, appDistDir, schemaPath })

    expect(await Bun.file(path.join(runtimeDir, "app", "index.html")).text()).toBe("second")
    expect(await Bun.file(path.join(runtimeDir, "app", "stale.js")).exists()).toBe(false)
  })
  test("maps build target names to runtime package directories", () => {
    expect(desktopRuntimePackageNames("darwin-x64,darwin-arm64")).toEqual([
      "synergy-darwin-x64",
      "synergy-darwin-arm64",
    ])
    expect(desktopRuntimePackageNames("win32-x64,linux-x64-baseline")).toEqual([
      "synergy-windows-x64",
      "synergy-linux-x64-baseline",
    ])
  })
})
