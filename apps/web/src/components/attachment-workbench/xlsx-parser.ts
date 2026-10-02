import * as XLSX from "xlsx"
import { validateOfficePackage } from "./office-package"
import { OfficePreviewError } from "./office-contract"
import type { SpreadsheetPreview, SpreadsheetSheet } from "./xlsx-model"

export function parseOfficeSpreadsheet(bytes: Uint8Array): SpreadsheetPreview {
  const checked = validateOfficePackage(bytes, "xlsx")
  try {
    const workbook = XLSX.read(checked.bytes, {
      type: "array",
      cellFormula: true,
      cellNF: true,
      cellStyles: true,
      cellHTML: false,
      bookVBA: false,
      cellDates: false,
    })
    const sheets = workbook.SheetNames.map((name) => {
      const source = workbook.Sheets[name]!
      const range = XLSX.utils.decode_range(source["!ref"] ?? "A1")
      const sheet: SpreadsheetSheet = {
        name,
        rowCount: range.e.r + 1,
        columnCount: range.e.c + 1,
        cells: Object.create(null),
        merges: [],
        rowHeights: {},
        columnWidths: {},
      }
      for (const [address, cell] of Object.entries(source)) {
        if (!/^[A-Z]+[1-9][0-9]*$/.test(address)) continue
        const value = cell as XLSX.CellObject
        sheet.cells[address] = {
          text: value.v === undefined ? (value.w ?? "") : XLSX.utils.format_cell(value),
          ...(value.f ? { formula: value.f } : {}),
        }
      }
      for (const merge of source["!merges"] ?? []) {
        sheet.rowCount = Math.max(sheet.rowCount, merge.e.r + 1)
        sheet.columnCount = Math.max(sheet.columnCount, merge.e.c + 1)
        sheet.merges.push({ start: { row: merge.s.r, column: merge.s.c }, end: { row: merge.e.r, column: merge.e.c } })
      }
      if (sheet.rowCount > 1_048_576 || sheet.columnCount > 16_384) throw new OfficePreviewError("unsupported")
      source["!rows"]?.forEach((row, index) => {
        if (row?.hidden) sheet.rowHeights[index] = 0
        else if (row?.hpx || row?.hpt) sheet.rowHeights[index] = Math.max(8, row.hpt ? (row.hpt * 4) / 3 : row.hpx!)
      })
      source["!cols"]?.forEach((column, index) => {
        if (column?.hidden) sheet.columnWidths[index] = 0
        else if (column?.wpx || column?.wch || column?.width)
          sheet.columnWidths[index] = Math.max(8, column.wpx ?? (column.wch ?? column.width!) * 7 + 5)
      })
      return sheet
    })
    if (!sheets.length) throw new OfficePreviewError("corrupt")
    return { sheets }
  } catch (error) {
    if (error instanceof OfficePreviewError) throw error
    throw new OfficePreviewError("corrupt")
  }
}
