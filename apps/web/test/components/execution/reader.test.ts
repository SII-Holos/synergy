import { expect, test } from "bun:test"
import { EvidencePages } from "../../../src/components/execution/reader-state"
test("continuous UTF-8 content is bounded and stays pinned to one version", () => {
  const pages = new EvidencePages(8 * 1024 * 1024)
  for (let i = 0; i < 500; i++)
    pages.put({
      contentVersion: "v1",
      sha256: null,
      offset: i * 65_535,
      text: "中".repeat(21_845),
      nextOffset: (i + 1) * 65_535,
      bytes: 32_767_500,
      mediaType: "application/json",
      status: "complete",
    })
  expect(pages.size).toBeLessThanOrEqual(8 * 1024 * 1024)
  expect(pages.pages().at(-1)?.offset).toBe(499 * 65_535)
  expect(() => pages.put({ ...pages.pages()[0], contentVersion: "v2" })).toThrow()
  pages.clear()
  expect(pages.size).toBe(0)
})
