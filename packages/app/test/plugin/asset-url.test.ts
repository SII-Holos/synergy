import { describe, expect, test } from "bun:test"
import { resolvePluginAssetUrl } from "../../src/plugin/asset-url"

describe("plugin asset URL resolution", () => {
  test.each([
    ["http://127.0.0.1:4096", "http://127.0.0.1:4096/plugin/assets/vibe-lingo/generation-one/ui/index.js"],
    [
      "https://example.test/proxy/4096",
      "https://example.test/proxy/4096/plugin/assets/vibe-lingo/generation-one/ui/index.js",
    ],
    [
      "https://example.test/proxy/4096/",
      "https://example.test/proxy/4096/plugin/assets/vibe-lingo/generation-one/ui/index.js",
    ],
  ])("resolves assets against the active server URL %s", (serverUrl, expected) => {
    expect(resolvePluginAssetUrl(serverUrl, "vibe-lingo", "generation-one", "./ui/index.js")).toBe(expected)
  })

  test("keeps plugin identifiers and artifact path segments encoded", () => {
    expect(resolvePluginAssetUrl("https://example.test/base", "plugin name", "hash/value", "icons/mark one.svg")).toBe(
      "https://example.test/base/plugin/assets/plugin%20name/hash%2Fvalue/icons/mark%20one.svg",
    )
  })
})
