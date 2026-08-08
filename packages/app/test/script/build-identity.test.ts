import { describe, expect, test } from "bun:test"
import { resolveAppBuildIdentity } from "../../script/build-identity"

describe("app build identity", () => {
  test("labels Vite development and source-managed builds with the current revision", () => {
    expect(
      resolveAppBuildIdentity({
        command: "serve",
        packageVersion: "1.1.26",
        revision: "123456789abcdef",
        dirty: true,
      }),
    ).toEqual({ label: "local@123456789+dirty", sourcemap: true })

    expect(
      resolveAppBuildIdentity({
        command: "build",
        sourceBuild: true,
        packageVersion: "1.1.26",
        revision: "abcdef123456789",
        dirty: false,
      }),
    ).toEqual({ label: "local@abcdef123", sourcemap: true })
  })

  test("keeps release builds on the package version without source maps", () => {
    expect(
      resolveAppBuildIdentity({
        command: "build",
        sourceBuild: false,
        packageVersion: "1.1.26",
        revision: "123456789abcdef",
        dirty: true,
      }),
    ).toEqual({ label: "1.1.26", sourcemap: false })
  })

  test("uses a deterministic local label when Git metadata is unavailable", () => {
    expect(
      resolveAppBuildIdentity({
        command: "build",
        sourceBuild: true,
        packageVersion: "1.1.26",
      }),
    ).toEqual({ label: "local", sourcemap: true })
  })
})
