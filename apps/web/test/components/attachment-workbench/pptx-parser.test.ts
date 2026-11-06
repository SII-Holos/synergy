import { expect, test } from "bun:test"
import { pptxSample } from "../../fixtures/office/pptx-sample"
import { parseOfficePresentation } from "../../../src/components/attachment-workbench/pptx-parser"

test("PPTX produces static readable slides, text, tables, embedded images and common shapes", async () => {
  const value = await parseOfficePresentation(await pptxSample())
  expect(value.pages).toHaveLength(2)
  expect(value.pages[0]!.text).toContain("中文幻灯片标题😀")
  expect(value.pages[0]!.text).toContain("中文表格")
  expect(value.pages[0]!.html).toContain("中文表格")
  expect(value.pages[0]!.html).toContain("常见形状")
  expect(value.pages[0]!.html).toContain("data:image/png")
  expect(value.pages[0]!.width).toBeGreaterThan(900)
  expect(value.pages[1]!.text).toContain("第二页幻灯片")
})
