import { describe, expect, test } from "bun:test"
import { requiredRuntimeArtifactPaths } from "../../../../script/release/nodes/validate-local-artifacts"

describe("release runtime artifact contract", () => {
  test("requires the filesystem-backed Playwright Core runtime", () => {
    expect(requiredRuntimeArtifactPaths("synergy-linux-x64")).toContain("browser-runtime/playwright-core/package.json")
    expect(requiredRuntimeArtifactPaths("synergy-darwin-arm64")).toContain(
      "browser-runtime/playwright-core/lib/coreBundle.js",
    )
  })

  test("requires the filesystem-backed ONNX Web embedding runtime", () => {
    expect(requiredRuntimeArtifactPaths("synergy-linux-x64")).toContain(
      "lib/onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs",
    )
    expect(requiredRuntimeArtifactPaths("synergy-darwin-arm64")).toContain(
      "lib/onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm",
    )
  })

  test("requires the filesystem-backed SVG raster runtime, fallback fonts, and license metadata", () => {
    expect(requiredRuntimeArtifactPaths("synergy-linux-x64")).toEqual(
      expect.arrayContaining([
        "lib/resvg-wasm/index_bg.wasm",
        "lib/resvg-wasm/LICENSE-MPL-2.0.txt",
        "lib/resvg-wasm/THIRD_PARTY_NOTICES.txt",
        "lib/resvg-wasm/fonts/noto-sans-sc-chinese-simplified-400-normal.woff2",
        "lib/resvg-wasm/fonts/noto-sans-sc-latin-400-normal.woff2",
        "lib/resvg-wasm/fonts/LICENSE-OFL-1.1.txt",
      ]),
    )
    expect(requiredRuntimeArtifactPaths("synergy-darwin-arm64")).toContain("lib/resvg-wasm/index_bg.wasm")
  })

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
