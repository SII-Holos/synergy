export interface CellPosition {
  row: number
  column: number
}
export interface CellRange {
  start: CellPosition
  end: CellPosition
}
export interface SpreadsheetCell {
  text: string
  formula?: string
}
export interface SpreadsheetSheet {
  name: string
  rowCount: number
  columnCount: number
  cells: Record<string, SpreadsheetCell>
  merges: CellRange[]
  rowHeights: Record<number, number>
  columnWidths: Record<number, number>
}
export interface SpreadsheetPreview {
  sheets: SpreadsheetSheet[]
}

export function cellAddress(row: number, column: number) {
  let label = "",
    index = column + 1
  while (index > 0) {
    label = String.fromCharCode(65 + ((index - 1) % 26)) + label
    index = Math.floor((index - 1) / 26)
  }
  return `${label}${row + 1}`
}

export function normalizedCellRange(range: CellRange): CellRange {
  return {
    start: { row: Math.min(range.start.row, range.end.row), column: Math.min(range.start.column, range.end.column) },
    end: { row: Math.max(range.start.row, range.end.row), column: Math.max(range.start.column, range.end.column) },
  }
}

export function rangeContains(range: CellRange, position: CellPosition) {
  return (
    position.row >= range.start.row &&
    position.row <= range.end.row &&
    position.column >= range.start.column &&
    position.column <= range.end.column
  )
}

export function mergedCell(sheet: SpreadsheetSheet, position: CellPosition) {
  return sheet.merges.find((range) => rangeContains(range, position))
}

export function spreadsheetSelectionText(sheet: SpreadsheetSheet, selection: CellRange) {
  const range = normalizedCellRange(selection)
  if ((range.end.row - range.start.row + 1) * (range.end.column - range.start.column + 1) > 100_000)
    throw new Error("selection-too-large")
  const rows: string[] = []
  for (let row = range.start.row; row <= range.end.row; row++) {
    const cells: string[] = []
    for (let column = range.start.column; column <= range.end.column; column++) {
      const merge = mergedCell(sheet, { row, column })
      const text =
        merge && (merge.start.row !== row || merge.start.column !== column)
          ? ""
          : (sheet.cells[cellAddress(row, column)]?.text ?? "")
      cells.push(/[\t\n\r"]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text)
    }
    rows.push(cells.join("\t"))
  }
  return rows.join("\n")
}

export function createGridAxis(count: number, defaultSize: number, overrides: Record<number, number>) {
  const changed = Object.keys(overrides)
    .map(Number)
    .filter((index) => index >= 0 && index < count)
    .sort((a, b) => a - b)
  const prefix = [0]
  for (const index of changed) prefix.push(prefix.at(-1)! + (overrides[index] ?? defaultSize) - defaultSize)
  const offset = (index: number) => {
    let start = 0,
      end = changed.length
    while (start < end) {
      const middle = (start + end) >>> 1
      if (changed[middle]! < index) start = middle + 1
      else end = middle
    }
    return index * defaultSize + prefix[start]!
  }
  return {
    count,
    total: offset(count),
    offset,
    size: (index: number) => overrides[index] ?? defaultSize,
    indexAt: (position: number) => {
      let start = 0,
        end = Math.max(0, count - 1)
      while (start < end) {
        const middle = Math.ceil((start + end) / 2)
        if (offset(middle) <= position) start = middle
        else end = middle - 1
      }
      return start
    },
  }
}
export type GridAxis = ReturnType<typeof createGridAxis>
export function gridVisibleRange(axis: GridAxis, offset: number, size: number) {
  return {
    start: Math.max(0, axis.indexAt(offset) - 2),
    end: Math.min(axis.count - 1, axis.indexAt(offset + size) + 2),
  }
}
