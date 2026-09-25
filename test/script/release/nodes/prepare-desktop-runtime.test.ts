import { expect, test } from "bun:test"
import { desktopRuntimePackageNames } from "../../../../script/release/prepare-desktop-runtime"

test("maps build target names to runtime package directories", () => {
  expect(desktopRuntimePackageNames("darwin-x64,darwin-arm64")).toEqual(["synergy-darwin-x64", "synergy-darwin-arm64"])
  expect(desktopRuntimePackageNames("win32-x64,linux-x64-baseline")).toEqual([
    "synergy-windows-x64",
    "synergy-linux-x64-baseline",
  ])
})
