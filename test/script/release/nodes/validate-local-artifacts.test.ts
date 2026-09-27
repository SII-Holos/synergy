import { describe, expect, test } from "bun:test"
import { requiredRuntimeArtifactPaths } from "../../../../script/release/shared/runtime-contract"

describe("release runtime artifact contract", () => {
  test("requires the filesystem-backed Playwright Core runtime", () => {
    expect(requiredRuntimeArtifactPaths("synergy-linux-x64")).toContain(
      "runtime/node_modules/playwright-core/package.json",
    )
    expect(requiredRuntimeArtifactPaths("synergy-darwin-arm64")).toContain(
      "runtime/node_modules/playwright-core/lib/coreBundle.js",
    )
  })

  test("requires the filesystem-backed ONNX Web embedding runtime", () => {
    expect(requiredRuntimeArtifactPaths("synergy-linux-x64")).toContain(
      "runtime/node_modules/@ericsanchezok/synergy-library/dist/lib/onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs",
    )
    expect(requiredRuntimeArtifactPaths("synergy-darwin-arm64")).toContain(
      "runtime/node_modules/@ericsanchezok/synergy-library/dist/lib/onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm",
    )
  })

  test("requires the filesystem-backed SVG raster runtime, fallback fonts, and license metadata", () => {
    expect(requiredRuntimeArtifactPaths("synergy-linux-x64")).toEqual(
      expect.arrayContaining([
        "runtime/node_modules/@ericsanchezok/synergy-connections/dist/lib/resvg-wasm/index_bg.wasm",
        "runtime/node_modules/@ericsanchezok/synergy-connections/dist/lib/resvg-wasm/LICENSE-MPL-2.0.txt",
        "runtime/node_modules/@ericsanchezok/synergy-connections/dist/lib/resvg-wasm/THIRD_PARTY_NOTICES.txt",
        "runtime/node_modules/@ericsanchezok/synergy-connections/dist/lib/resvg-wasm/fonts/noto-sans-sc-chinese-simplified-400-normal.woff2",
        "runtime/node_modules/@ericsanchezok/synergy-connections/dist/lib/resvg-wasm/fonts/noto-sans-sc-latin-400-normal.woff2",
        "runtime/node_modules/@ericsanchezok/synergy-connections/dist/lib/resvg-wasm/fonts/LICENSE-OFL-1.1.txt",
      ]),
    )
    expect(requiredRuntimeArtifactPaths("synergy-darwin-arm64")).toContain(
      "runtime/node_modules/@ericsanchezok/synergy-connections/dist/lib/resvg-wasm/index_bg.wasm",
    )
  })

  test("requires the Linux sandbox helper in every Linux package variant", () => {
    expect(requiredRuntimeArtifactPaths("synergy-linux-x64")).toContain(
      "runtime/node_modules/@ericsanchezok/synergy-native-linux-x64-glibc/synergy-sandbox-linux",
    )
    expect(requiredRuntimeArtifactPaths("synergy-linux-x64-baseline-musl")).toContain(
      "runtime/node_modules/@ericsanchezok/synergy-native-linux-x64-musl/synergy-sandbox-linux",
    )
  })

  test("requires the Windows sandbox helper", () => {
    expect(requiredRuntimeArtifactPaths("synergy-windows-x64")).toContain(
      "runtime/node_modules/@ericsanchezok/synergy-native-win32-x64/synergy-sandbox-windows.exe",
    )
  })

  test("does not require a helper on macOS", () => {
    expect(requiredRuntimeArtifactPaths("synergy-darwin-arm64").some((item) => item.includes("synergy-sandbox"))).toBe(
      false,
    )
  })
})
