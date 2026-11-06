import { batch, createEffect, createMemo, createSignal, For, on, onCleanup, onMount } from "solid-js"
import { useLingui } from "@lingui/solid"
import { copyTextToClipboard } from "@ericsanchezok/synergy-ui/clipboard"
import {
  cellAddress,
  createGridAxis,
  gridVisibleRange,
  mergedCell,
  normalizedCellRange,
  rangeContains,
  spreadsheetSelectionText,
  type CellPosition,
  type CellRange,
  type SpreadsheetSheet,
} from "./xlsx-model"

const rowHeaderWidth = 44,
  columnHeaderHeight = 28,
  maximumCanvasHeight = 16_000_000

export function SpreadsheetGrid(props: { sheet: SpreadsheetSheet }) {
  const lingui = useLingui()
  let root!: HTMLDivElement
  let dragging = false
  const [selection, setSelection] = createSignal<CellRange>({
    start: { row: 0, column: 0 },
    end: { row: 0, column: 0 },
  })
  const [scrollTop, setScrollTop] = createSignal(0),
    [scrollLeft, setScrollLeft] = createSignal(0)
  const [height, setHeight] = createSignal(0),
    [width, setWidth] = createSignal(0)
  const [query, setQuery] = createSignal(""),
    [copyError, setCopyError] = createSignal(false)
  const rows = createMemo(() => createGridAxis(props.sheet.rowCount, 28, props.sheet.rowHeights))
  const columns = createMemo(() => createGridAxis(props.sheet.columnCount, 120, props.sheet.columnWidths))
  const physicalHeight = () => Math.min(maximumCanvasHeight, rows().total)
  const scrollFactor = () => Math.max(1, (rows().total - height()) / Math.max(1, physicalHeight() - height()))
  const logicalTop = () => scrollTop() * scrollFactor()
  const rowRange = createMemo(() => gridVisibleRange(rows(), logicalTop(), height()))
  const columnRange = createMemo(() => gridVisibleRange(columns(), scrollLeft(), width()))
  const normalized = createMemo(() => normalizedCellRange(selection()))
  const active = () => selection().end
  const currentCell = () => props.sheet.cells[cellAddress(active().row, active().column)]
  const addresses = createMemo(() =>
    Object.keys(props.sheet.cells)
      .map((address) => {
        const match = /^([A-Z]+)([0-9]+)$/.exec(address)!
        let column = 0
        for (const char of match[1]!) column = column * 26 + char.charCodeAt(0) - 64
        return { address, row: Number(match[2]) - 1, column: column - 1 }
      })
      .sort((a, b) => a.row - b.row || a.column - b.column),
  )
  const matches = createMemo(() =>
    query().trim()
      ? addresses().filter((position) =>
          props.sheet.cells[position.address]!.text.toLocaleLowerCase().includes(query().toLocaleLowerCase()),
        )
      : [],
  )
  const rowIndices = createMemo(() => {
    const indices = new Set<number>()
    for (let row = rowRange().start; row <= rowRange().end; row++) if (rows().size(row) > 0) indices.add(row)
    for (const merge of props.sheet.merges)
      if (
        merge.end.row >= rowRange().start &&
        merge.start.row <= rowRange().end &&
        merge.end.column >= columnRange().start &&
        merge.start.column <= columnRange().end
      )
        indices.add(merge.start.row)
    return [...indices].sort((a, b) => a - b)
  })
  const columnIndices = createMemo(() => {
    const indices: number[] = []
    for (let column = columnRange().start; column <= columnRange().end; column++)
      if (columns().size(column) > 0) indices.push(column)
    return indices
  })
  const rowCells = (row: number) => {
    const indices = new Set(columnIndices())
    for (const merge of props.sheet.merges)
      if (
        merge.start.row === row &&
        merge.end.row >= rowRange().start &&
        merge.end.column >= columnRange().start &&
        merge.start.column <= columnRange().end
      )
        indices.add(merge.start.column)
    return [...indices]
      .sort((a, b) => a - b)
      .flatMap((column) => {
        const merge = mergedCell(props.sheet, { row, column })
        if (merge && (merge.start.row !== row || merge.start.column !== column)) return []
        return [{ row, column, merge }]
      })
  }
  const reveal = (position: CellPosition) => {
    const top = rows().offset(position.row),
      bottom = top + rows().size(position.row)
    const left = columns().offset(position.column),
      right = left + columns().size(position.column)
    if (top < logicalTop()) root.scrollTop = top / scrollFactor()
    else if (bottom > logicalTop() + height()) root.scrollTop = (bottom - height()) / scrollFactor()
    if (left < scrollLeft()) root.scrollLeft = left
    else if (right > scrollLeft() + width()) root.scrollLeft = right - width()
  }
  const goTo = (position: CellPosition, extend = false) => {
    const current = {
      row: Math.max(0, Math.min(props.sheet.rowCount - 1, position.row)),
      column: Math.max(0, Math.min(props.sheet.columnCount - 1, position.column)),
    }
    setSelection({ start: extend ? selection().start : current, end: current })
    reveal(current)
  }
  createEffect(
    on(
      () => props.sheet,
      () => {
        batch(() => {
          setSelection({ start: { row: 0, column: 0 }, end: { row: 0, column: 0 } })
          setQuery("")
          setScrollTop(0)
          setScrollLeft(0)
          setCopyError(false)
        })
        if (root) {
          root.scrollTop = 0
          root.scrollLeft = 0
        }
      },
    ),
  )
  createEffect(
    on(matches, (values) => {
      const first = values[0]
      if (first) goTo(first)
    }),
  )
  onMount(() => {
    const observer = new ResizeObserver((entries) => {
      const size = entries[0]?.contentRect
      if (size)
        batch(() => {
          setWidth(Math.max(0, size.width - rowHeaderWidth))
          setHeight(Math.max(0, size.height - columnHeaderHeight))
        })
    })
    observer.observe(root)
    onCleanup(() => observer.disconnect())
  })
  const copiedText = () => {
    try {
      const value = spreadsheetSelectionText(props.sheet, selection())
      setCopyError(false)
      return value
    } catch {
      setCopyError(true)
      return undefined
    }
  }
  const copy = async () => {
    const value = copiedText()
    if (value !== undefined)
      await copyTextToClipboard(value, {
        label: lingui._({ id: "app.attachment.xlsx.copyCells", message: "Copy selected cells" }),
      })
  }
  const selectAtPointer = (event: PointerEvent) => {
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-sheet-cell]")
    if (!target || !root.contains(target)) return
    goTo({ row: Number(target.dataset.row), column: Number(target.dataset.column) }, dragging || event.shiftKey)
  }
  const keydown = (event: KeyboardEvent) => {
    const position = active(),
      merge = mergedCell(props.sheet, position)
    const point = { ...position }
    if (event.key === "ArrowRight") point.column = (merge?.end.column ?? point.column) + 1
    else if (event.key === "ArrowLeft") point.column = (merge?.start.column ?? point.column) - 1
    else if (event.key === "ArrowDown") point.row = (merge?.end.row ?? point.row) + 1
    else if (event.key === "ArrowUp") point.row = (merge?.start.row ?? point.row) - 1
    else if (event.key === "Home") {
      point.column = 0
      if (event.ctrlKey || event.metaKey) point.row = 0
    } else if (event.key === "End") {
      point.column = props.sheet.columnCount - 1
      if (event.ctrlKey || event.metaKey) point.row = props.sheet.rowCount - 1
    } else if (event.key === "PageDown") point.row = rows().indexAt(rows().offset(point.row) + height())
    else if (event.key === "PageUp") point.row = rows().indexAt(Math.max(0, rows().offset(point.row) - height()))
    else return
    event.preventDefault()
    goTo(point, event.shiftKey)
  }
  return (
    <>
      <div class="office-reader-toolbar">
        <label class="office-reader-find">
          <input
            aria-label={lingui._({ id: "app.attachment.office.find", message: "Find in document" })}
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
        <span role="status">
          {query().trim()
            ? lingui._({
                id: "app.attachment.xlsx.matches",
                message: "{count} matching cells",
                values: { count: matches().length },
              })
            : cellAddress(active().row, active().column)}
        </span>
        <button
          type="button"
          disabled={!matches().length}
          onClick={() =>
            goTo(
              matches().find(
                (position) =>
                  position.row > active().row || (position.row === active().row && position.column > active().column),
              ) ?? matches()[0]!,
            )
          }
        >
          {lingui._({ id: "app.attachment.office.nextMatch", message: "Next match" })}
        </button>
        <button type="button" onClick={() => void copy()}>
          {lingui._({ id: "app.attachment.xlsx.copyCells", message: "Copy selected cells" })}
        </button>
      </div>
      <div class="xlsx-formula-bar">
        <strong>{cellAddress(active().row, active().column)}</strong>
        <input
          readonly
          aria-label={lingui._({ id: "app.attachment.xlsx.cellValue", message: "Cell value or formula" })}
          value={currentCell()?.formula ? `=${currentCell()!.formula}` : (currentCell()?.text ?? "")}
        />
      </div>
      <ShowCopyError visible={copyError()} />
      <div
        class="xlsx-grid"
        ref={root}
        tabIndex={0}
        role="grid"
        aria-label={props.sheet.name}
        aria-readonly="true"
        aria-rowcount={props.sheet.rowCount + 1}
        aria-colcount={props.sheet.columnCount + 1}
        aria-activedescendant={`sheet-cell-${active().row}-${active().column}`}
        onScroll={(event) =>
          batch(() => {
            setScrollTop(event.currentTarget.scrollTop)
            setScrollLeft(event.currentTarget.scrollLeft)
          })
        }
        onKeyDown={keydown}
        onCopy={(event) => {
          const value = copiedText()
          event.preventDefault()
          if (value !== undefined) event.clipboardData?.setData("text/plain", value)
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          selectAtPointer(event)
          root.focus({ preventScroll: true })
          if (event.pointerType === "mouse") {
            dragging = true
            root.setPointerCapture(event.pointerId)
            event.preventDefault()
          }
        }}
        onPointerMove={(event) => {
          if (dragging) selectAtPointer(event)
        }}
        onPointerUp={() => {
          dragging = false
        }}
        onPointerCancel={() => {
          dragging = false
        }}
        onLostPointerCapture={() => {
          dragging = false
        }}
      >
        <div
          class="xlsx-column-headings"
          role="row"
          aria-rowindex={1}
          style={{ width: `${Math.max(width() + rowHeaderWidth, columns().total + rowHeaderWidth)}px` }}
        >
          <div class="xlsx-corner" role="columnheader" />
          <For each={columnIndices()}>
            {(column) => (
              <div
                class="xlsx-column-heading"
                role="columnheader"
                aria-colindex={column + 2}
                style={{ left: `${rowHeaderWidth + columns().offset(column)}px`, width: `${columns().size(column)}px` }}
              >
                {cellAddress(0, column).replace(/1$/, "")}
              </div>
            )}
          </For>
        </div>
        <div
          class="xlsx-grid-canvas"
          role="rowgroup"
          style={{
            width: `${Math.max(width() + rowHeaderWidth, columns().total + rowHeaderWidth)}px`,
            height: `${physicalHeight()}px`,
          }}
        >
          <For each={rowIndices()}>
            {(row) => (
              <div
                class="xlsx-row"
                role="row"
                aria-rowindex={row + 2}
                style={{ top: `${rows().offset(row) - logicalTop() + scrollTop()}px`, height: `${rows().size(row)}px` }}
              >
                <div class="xlsx-row-heading" role="rowheader">
                  {row + 1}
                </div>
                <For each={rowCells(row)}>
                  {(cell) => {
                    const value = () => props.sheet.cells[cellAddress(cell.row, cell.column)]
                    const end = cell.merge?.end ?? cell
                    const selected = () => rangeContains(normalized(), cell)
                    return (
                      <div
                        id={`sheet-cell-${cell.row}-${cell.column}`}
                        class="xlsx-cell"
                        data-sheet-cell
                        data-row={cell.row}
                        data-column={cell.column}
                        role="gridcell"
                        aria-colindex={cell.column + 2}
                        aria-rowspan={cell.merge ? end.row - cell.row + 1 : undefined}
                        aria-colspan={cell.merge ? end.column - cell.column + 1 : undefined}
                        aria-selected={selected()}
                        title={value()?.text}
                        style={{
                          left: `${rowHeaderWidth + columns().offset(cell.column)}px`,
                          width: `${columns().offset(end.column + 1) - columns().offset(cell.column)}px`,
                          height: `${rows().offset(end.row + 1) - rows().offset(cell.row)}px`,
                        }}
                      >
                        {value()?.text}
                      </div>
                    )
                  }}
                </For>
              </div>
            )}
          </For>
        </div>
      </div>
    </>
  )
}

function ShowCopyError(props: { visible: boolean }) {
  const lingui = useLingui()
  return (
    <div class="xlsx-copy-error" role="status" hidden={!props.visible}>
      {lingui._({ id: "app.attachment.xlsx.copyTooLarge", message: "Select fewer than 100,000 cells to copy." })}
    </div>
  )
}
