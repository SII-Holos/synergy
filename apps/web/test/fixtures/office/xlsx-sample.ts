import * as XLSX from "xlsx"
export function xlsxSample() {
  const workbook = XLSX.utils.book_new()
  const sheet = XLSX.utils.aoa_to_sheet([
    ["中文标题", null, "类型"],
    [12.5, 2, "数据"],
  ])
  sheet.B2 = { t: "n", v: 25, f: "A2*2", z: "0.00" }
  sheet.A100000 = { t: "s", v: "远端单元格" }
  sheet["!ref"] = "A1:C100000"
  sheet["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }]
  sheet["!rows"] = [{ hpt: 36 }]
  sheet["!cols"] = [{ wch: 24 }, { wch: 12 }, { wch: 16 }]
  XLSX.utils.book_append_sheet(workbook, sheet, "汇总")
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["第二工作表"]]), "明细")
  return new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx" }))
}
