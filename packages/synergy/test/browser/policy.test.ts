import { describe, expect, test } from "bun:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { BrowserPolicy } from "../../src/browser/policy"

describe("BrowserPolicy URL normalization", () => {
  test("normalizes bare domains and search text", () => {
    expect(BrowserPolicy.normalizeBrowserURL("google.com")).toBe("https://google.com")
    expect(BrowserPolicy.normalizeBrowserURL("localhost:5173")).toBe("http://localhost:5173")
    expect(BrowserPolicy.normalizeBrowserURL("hello browser")).toBe("https://www.google.com/search?q=hello%20browser")
  })
})

describe("BrowserPolicy navigation", () => {
  test("allows HTTP navigation without classifying the destination address or port", () => {
    const result = BrowserPolicy.hardCheckNavigation("https://example.com/", process.cwd())
    expect(result.decision).toBe("allow")
    expect(BrowserPolicy.hardCheckNavigation("http://localhost:6379/", process.cwd()).decision).toBe("allow")
    expect(BrowserPolicy.hardCheckNavigation("http://198.18.0.102/", process.cwd()).decision).toBe("allow")
  })

  test("allows file URLs only inside workspace", () => {
    const inside = path.join(process.cwd(), "package.json")
    expect(BrowserPolicy.hardCheckNavigation(pathToFileURL(inside).href, process.cwd()).decision).toBe("allow")
    expect(BrowserPolicy.hardCheckNavigation("file:///etc/passwd", process.cwd()).decision).toBe("deny")
  })

  test("checks blocked file segments inside directories whose names start with two dots", () => {
    const filePath = path.join(process.cwd(), "..cache", ".synergy", "token.json")
    const result = BrowserPolicy.hardCheckNavigation(pathToFileURL(filePath).href, process.cwd())
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("blocked segment")
  })
  test("rejects unsupported protocols", () => {
    expect(BrowserPolicy.hardCheckNavigation("javascript:alert(1)", process.cwd()).decision).toBe("deny")
  })
})

describe("BrowserPolicy download safety", () => {
  test("blocks dangerous download MIME types and executable filenames", () => {
    expect(BrowserPolicy.isDangerousDownload({ mimeType: "application/x-msdownload", filename: "setup.bin" })).toBe(
      true,
    )
    expect(BrowserPolicy.isDangerousDownload({ mimeType: "unknown/unknown", filename: "setup.exe" })).toBe(true)
    expect(BrowserPolicy.isDangerousDownload({ mimeType: "application/pdf", filename: "guide.pdf" })).toBe(false)
  })
})
