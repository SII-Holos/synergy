import { expect, test } from "bun:test"
import { CUA_DRIVER_RELEASE } from "../../src/computer/release"
import config from "../../electron-builder.json"
import manifest from "../../package.json"

test("macOS packages the source-pinned worker and unpacks both native SDK library formats", async () => {
  expect(manifest.dependencies["@trycua/cua-driver"]).toBe(CUA_DRIVER_RELEASE.version)
  expect(config.mac.extraResources).toContainEqual({ from: "build/computer", to: "computer" })
  expect(config.mac.binaries).toContain("Contents/Resources/computer/cua-driver")
  expect(config.asarUnpack).toContain("**/*.node")
  expect(config.asarUnpack).toContain("**/*.dylib")
  expect(CUA_DRIVER_RELEASE.sourceSha256).toMatch(/^[a-f0-9]{64}$/)
  expect(CUA_DRIVER_RELEASE.commit).toMatch(/^[a-f0-9]{40}$/)
  const notice = await Bun.file(new URL("../../build/computer-notices/NOTICE.txt", import.meta.url)).text()
  expect(notice).toContain(CUA_DRIVER_RELEASE.version)
  expect(await Bun.file(new URL("../../build/computer-notices/LICENSE.txt", import.meta.url)).text()).toContain(
    "Permission is hereby granted",
  )
})
