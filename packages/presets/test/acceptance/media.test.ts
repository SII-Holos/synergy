import { expect, test } from "bun:test"
import { chromium } from "playwright-core"
import { mediaFixtures } from "../../script/acceptance/media-fixtures"

test("media fixtures contain independent random document and raster content with preserved original bytes", async () => {
  const files = await mediaFixtures(chromium.executablePath())
  expect(new Set(files.map((file) => file.marker)).size).toBe(files.length)
  expect(files.map((file) => file.filename)).toEqual([
    "visual.png",
    "visual.jpg",
    "record.pdf",
    "record.docx",
    "record.xlsx",
    "record.pptx",
    "record.txt",
  ])
  for (const file of files) {
    expect(file.bytes.length).toBeGreaterThan(20)
    expect(file.filename).not.toContain(file.marker)
  }
  expect(files[0]!.bytes.subarray(1, 4).toString()).toBe("PNG")
  expect(files[1]!.bytes.subarray(0, 2).toString("hex")).toBe("ffd8")
  expect(files[2]!.bytes.subarray(0, 4).toString()).toBe("%PDF")
}, 30_000)
