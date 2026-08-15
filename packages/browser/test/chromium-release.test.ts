import { describe, expect, test } from "bun:test"
import {
  ChromiumManifestSchema,
  chromiumManifestArtifacts,
  chromiumManifestName,
  chromiumReleaseTarget,
} from "../src/chromium-release"

describe("Chromium release contract", () => {
  test("names only the five supported Stable target manifests", () => {
    const artifacts = chromiumManifestArtifacts("1.2.3")

    expect(artifacts).toHaveLength(10)
    expect(artifacts).toContain("synergy-chromium-darwin-arm64-1.2.3.manifest.json")
    expect(artifacts).toContain("synergy-chromium-linux-x64-1.2.3.manifest.json.sig")
    expect(artifacts).toContain("synergy-chromium-win32-x64-1.2.3.manifest.json")
    expect(artifacts.some((name) => name.includes("musl") || name.includes("win32-arm64"))).toBe(false)
  })

  test("maps Playwright Chromium metadata to exact platform artifacts", () => {
    expect(chromiumReleaseTarget("darwin", "arm64", "149.0.7827.55", "1228")).toEqual({
      platform: "darwin",
      arch: "arm64",
      name: "chrome-mac-arm64.zip",
      executable: "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      path: "builds/cft/149.0.7827.55/mac-arm64/chrome-mac-arm64.zip",
      urls: ["https://cdn.playwright.dev/builds/cft/149.0.7827.55/mac-arm64/chrome-mac-arm64.zip"],
    })
    expect(chromiumReleaseTarget("linux", "arm64", "149.0.7827.55", "1228")).toEqual({
      platform: "linux",
      arch: "arm64",
      name: "chromium-linux-arm64.zip",
      executable: "chrome-linux/chrome",
      path: "builds/chromium/1228/chromium-linux-arm64.zip",
      urls: [
        "https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/1228/chromium-linux-arm64.zip",
        "https://playwright.download.prss.microsoft.com/dbazure/download/playwright/builds/chromium/1228/chromium-linux-arm64.zip",
        "https://cdn.playwright.dev/builds/chromium/1228/chromium-linux-arm64.zip",
      ],
    })
    expect(chromiumReleaseTarget("win32", "arm64", "149.0.7827.55", "1228")).toBeNull()
  })

  test("pairs Chromium artifact paths with the matching Playwright mirrors", () => {
    const chromeForTesting = chromiumReleaseTarget("linux", "x64", "149.0.7827.55", "1228")
    expect(chromeForTesting?.urls).toEqual([
      "https://cdn.playwright.dev/builds/cft/149.0.7827.55/linux64/chrome-linux64.zip",
    ])

    const legacyChromium = chromiumReleaseTarget("linux", "arm64", "149.0.7827.55", "1228")
    expect(legacyChromium?.urls).toEqual([
      "https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/1228/chromium-linux-arm64.zip",
      "https://playwright.download.prss.microsoft.com/dbazure/download/playwright/builds/chromium/1228/chromium-linux-arm64.zip",
      "https://cdn.playwright.dev/builds/chromium/1228/chromium-linux-arm64.zip",
    ])
  })

  test("strictly validates signed Chromium metadata", () => {
    const target = chromiumReleaseTarget("linux", "x64", "149.0.7827.55", "1228")!
    const manifest = {
      version: "1.2.3",
      platform: target.platform,
      arch: target.arch,
      name: target.name,
      sha256: "a".repeat(64),
      size: 1024,
      url: target.urls[0],
      executable: target.executable,
      browserVersion: "149.0.7827.55",
      revision: "1228",
    }

    expect(ChromiumManifestSchema.parse(manifest)).toEqual(manifest)
    expect(ChromiumManifestSchema.safeParse({ ...manifest, extra: true }).success).toBe(false)
    expect(ChromiumManifestSchema.safeParse({ ...manifest, sha256: "bad" }).success).toBe(false)
    expect(ChromiumManifestSchema.safeParse({ ...manifest, url: "http://example.com/chrome.zip" }).success).toBe(false)
    expect(chromiumManifestName("1.2.3", "linux", "x64")).toBe("synergy-chromium-linux-x64-1.2.3.manifest.json")
  })

  test("maps Windows and macOS x64 targets and rejects unsupported pairs", () => {
    expect(chromiumReleaseTarget("win32", "x64", "149.0.7827.55", "1228")).toEqual({
      platform: "win32",
      arch: "x64",
      name: "chrome-win64.zip",
      executable: "chrome-win64/chrome.exe",
      path: "builds/cft/149.0.7827.55/win64/chrome-win64.zip",
      urls: ["https://cdn.playwright.dev/builds/cft/149.0.7827.55/win64/chrome-win64.zip"],
    })
    expect(chromiumReleaseTarget("darwin", "x64", "149.0.7827.55", "1228")?.name).toBe("chrome-mac-x64.zip")
    expect(chromiumReleaseTarget("linux", "x64", "149.0.7827.55", "1228")?.name).toBe("chrome-linux64.zip")
    expect(chromiumReleaseTarget("win32", "arm64", "149.0.7827.55", "1228")).toBeNull()
    expect(chromiumManifestName("1.2.3", "darwin", "x64")).toBe("synergy-chromium-darwin-x64-1.2.3.manifest.json")
  })
})
