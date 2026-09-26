import { describe, expect, test } from "bun:test"
import { BROWSER_MAX_DOWNLOAD_BYTES, browserDownloadExceedsLimit, sanitizeBrowserFilename } from "../src/file-safety"

describe("Browser filename safety", () => {
  test("normalizes traversal, Windows device names, alternate streams, and empty names", () => {
    expect(sanitizeBrowserFilename("../../report.txt")).toBe("report.txt")
    expect(sanitizeBrowserFilename("..\\..\\report.txt")).toBe("report.txt")
    expect(sanitizeBrowserFilename("CON.txt")).toBe("_CON.txt")
    expect(sanitizeBrowserFilename("invoice.txt:payload.exe")).toBe("invoice.txt_payload.exe")
    expect(sanitizeBrowserFilename("...", "download")).toBe("download")
    expect(sanitizeBrowserFilename("name. ")).toBe("name")
  })

  test("applies an exact finite managed-download size limit", () => {
    expect(browserDownloadExceedsLimit(BROWSER_MAX_DOWNLOAD_BYTES)).toBe(false)
    expect(browserDownloadExceedsLimit(BROWSER_MAX_DOWNLOAD_BYTES + 1)).toBe(true)
    expect(browserDownloadExceedsLimit(Number.NaN, -1)).toBe(false)
  })
})
