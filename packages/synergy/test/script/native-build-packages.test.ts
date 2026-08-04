import { describe, expect, test } from "bun:test"
import { nativePlatformPackageNames } from "../../script/native-build-packages"
import pkg from "../../package.json"

describe("native platform build packages", () => {
  test("extracts every declared ast-grep, sqlite-vec, and parcel watcher platform package", () => {
    const dependencies = { ...pkg.dependencies, ...pkg.devDependencies } as Record<string, string>
    const names = new Set(nativePlatformPackageNames(dependencies))

    for (const name of Object.keys(dependencies)) {
      if (name.startsWith("@ast-grep/cli-") || name.startsWith("sqlite-vec-") || name.startsWith("@parcel/watcher-")) {
        expect(names.has(name), `${name} must be force-extracted for cross-platform release builds`).toBe(true)
      }
    }
  })

  test("keeps non-platform dependencies out of the force-extraction list", () => {
    const names = nativePlatformPackageNames({
      "sqlite-vec": "0.1.7-alpha.2",
      "@parcel/watcher": "2.5.6",
      "@ast-grep/cli": "0.40.5",
      "some-regular-dep": "1.0.0",
    })

    expect(names).toEqual([])
  })

  test("matches platform packages by exact platform prefix", () => {
    const names = nativePlatformPackageNames({
      "@ast-grep/cli-win32-x64-msvc": "0.40.5",
      "sqlite-vec-windows-x64": "0.1.7-alpha.2",
      "@parcel/watcher-darwin-arm64": "2.5.6",
      "unrelated-platform-tool": "1.0.0",
    })

    expect(names).toEqual(["@ast-grep/cli-win32-x64-msvc", "sqlite-vec-windows-x64", "@parcel/watcher-darwin-arm64"])
  })
})
