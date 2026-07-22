import { describe, expect, test } from "bun:test"
import { requiredRuntimeArtifactPaths } from "../../../../script/release/nodes/validate-local-artifacts"

describe("release runtime artifact contract", () => {
  test("requires the Linux sandbox helper in every Linux package variant", () => {
    expect(requiredRuntimeArtifactPaths("synergy-linux-x64")).toContain("sandbox/synergy-sandbox-linux")
    expect(requiredRuntimeArtifactPaths("synergy-linux-x64-baseline-musl")).toContain("sandbox/synergy-sandbox-linux")
  })

  test("requires the Windows sandbox helper", () => {
    expect(requiredRuntimeArtifactPaths("synergy-windows-x64")).toContain("sandbox/synergy-sandbox-windows.exe")
  })

  test("does not require a helper on macOS", () => {
    expect(requiredRuntimeArtifactPaths("synergy-darwin-arm64")).not.toContain("sandbox/synergy-sandbox-linux")
    expect(requiredRuntimeArtifactPaths("synergy-darwin-arm64")).not.toContain("sandbox/synergy-sandbox-windows.exe")
  })
})
