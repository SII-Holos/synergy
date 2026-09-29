import { expect, test } from "bun:test"
import { CUA_DRIVER_RELEASE } from "../../src/computer/release"
import config from "../../electron-builder.json"
import manifest from "../../package.json"
import { nativeSdkEntry } from "../../src/computer/sdk-entry"

test("the packaged SDK resolves native libraries from physical package directories", () => {
  expect(
    nativeSdkEntry(
      "file:///Applications/Synergy.app/Contents/Resources/app.asar/node_modules/@trycua/cua-driver/dist/index.js",
    ),
  ).toBe(
    "file:///Applications/Synergy.app/Contents/Resources/app.asar.unpacked/node_modules/@trycua/cua-driver/dist/index.js",
  )
  expect(nativeSdkEntry("file:///development/node_modules/@trycua/cua-driver/dist/index.js")).toBe(
    "file:///development/node_modules/@trycua/cua-driver/dist/index.js",
  )
  expect(config.asarUnpack).toContain("node_modules/@trycua/**")
  expect(config.asarUnpack).toContain("node_modules/@ubjs/**")
})

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
