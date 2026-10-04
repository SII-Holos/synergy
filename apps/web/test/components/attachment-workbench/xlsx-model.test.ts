import { expect, test } from "bun:test"
import * as XLSX from "xlsx"
import { parseOfficeSpreadsheet } from "../../../src/components/attachment-workbench/xlsx-parser"
import {
  createGridAxis,
  gridVisibleRange,
  spreadsheetSelectionText,
} from "../../../src/components/attachment-workbench/xlsx-model"

function sample() {
  const workbook = XLSX.utils.book_new()
  const sheet = XLSX.utils.aoa_to_sheet([
    ["中文标题", null],
    [12.5, 2],
    [null, null],
  ])
  sheet.B2 = { t: "n", v: 25, f: "A2*2", z: "0.00" }
  sheet["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }]
  sheet["!cols"] = [{ wch: 24 }, { wch: 12 }]
  sheet["!rows"] = [{ hpt: 36 }]
  XLSX.utils.book_append_sheet(workbook, sheet, "汇总")
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["第二工作表"]]), "明细")
  return new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx" }))
}

test("XLSX preserves worksheets, merges, dimensions and cached formula values without evaluating", () => {
  const value = parseOfficeSpreadsheet(sample())
  expect(value.sheets.map((sheet) => sheet.name)).toEqual(["汇总", "明细"])
  expect(value.sheets[0]!.cells.B2).toMatchObject({ text: "25.00", formula: "A2*2" })
  expect(value.sheets[0]!.merges).toEqual([{ start: { row: 0, column: 0 }, end: { row: 0, column: 1 } }])
  expect(value.sheets[0]!.rowHeights[0]).toBe(48)
  expect(value.sheets[0]!.columnWidths[0]).toBeGreaterThan(100)
  expect(spreadsheetSelectionText(value.sheets[0]!, { start: { row: 0, column: 0 }, end: { row: 1, column: 1 } })).toBe(
    "中文标题\t\n12.5\t25.00",
  )
})

test("spreadsheet axis virtualizes large sparse sheets while respecting changed dimensions", () => {
  const axis = createGridAxis(1_000_000, 28, { 1: 48, 999999: 56 })
  expect(axis.offset(2)).toBe(76)
  expect(axis.size(999999)).toBe(56)
  const range = gridVisibleRange(axis, axis.offset(700000), 420)
  expect(range.start).toBeLessThanOrEqual(700000)
  expect(range.end - range.start).toBeLessThan(25)
})
