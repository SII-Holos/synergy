import { highlightInputAllowed } from "../pierre/cache-budget"
import {
  type FileContents,
  File,
  FileOptions,
  LineAnnotation,
  type RenderRange,
  type SelectedLineRange,
} from "@pierre/diffs"
import { ComponentProps, createEffect, createMemo, onCleanup, splitProps } from "solid-js"
import { createDefaultOptions, styleVariables } from "../pierre"
import { getWorkerPool } from "../pierre/worker"

type SelectionSide = "additions" | "deletions"

export type CodeProps<T = {}> = FileOptions<T> & {
  file: FileContents
  annotations?: LineAnnotation<T>[]
  selectedLines?: SelectedLineRange | null
  renderRange?: RenderRange
  class?: string
  classList?: ComponentProps<"div">["classList"]
}

function findElement(node: Node | null): HTMLElement | undefined {
  if (!node) return
  if (node instanceof HTMLElement) return node
  return node.parentElement ?? undefined
}

function findLineNumber(node: Node | null): number | undefined {
  const element = findElement(node)
  if (!element) return

  const line = element.closest("[data-line]")
  if (!(line instanceof HTMLElement)) return

  const value = parseInt(line.dataset.line ?? "", 10)
  if (Number.isNaN(value)) return

  return value
}

function findSide(node: Node | null): SelectionSide | undefined {
  const element = findElement(node)
  if (!element) return

  const code = element.closest("[data-code]")
  if (!(code instanceof HTMLElement)) return

  if (code.hasAttribute("data-deletions")) return "deletions"
  return "additions"
}

function sameFileContents(a: FileContents | undefined, b: FileContents | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.name === b.name &&
    a.contents === b.contents &&
    a.cacheKey === b.cacheKey &&
    a.lang === b.lang &&
    a.header === b.header
  )
}

function sameRenderRange(a: RenderRange | undefined, b: RenderRange | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.startingLine === b.startingLine &&
    a.totalLines === b.totalLines &&
    a.bufferBefore === b.bufferBefore &&
    a.bufferAfter === b.bufferAfter
  )
}

function plainFileRange(contents: string, range: RenderRange | undefined) {
  if (!range) return contents
  if (range.totalLines <= 0) return ""
  let start = 0
  for (let line = 0; line < range.startingLine; line++) {
    const next = contents.indexOf("\n", start)
    if (next < 0) return ""
    start = next + 1
  }
  if (range.totalLines === Infinity) return contents.slice(start)
  let end = start
  for (let line = 0; line < range.totalLines; line++) {
    const next = contents.indexOf("\n", end)
    if (next < 0) return contents.slice(start)
    end = next + 1
  }
  return contents.slice(start, end)
}

export function Code<T>(props: CodeProps<T>) {
  let container!: HTMLDivElement

  const [local, others] = splitProps(props, [
    "file",
    "class",
    "classList",
    "annotations",
    "selectedLines",
    "renderRange",
  ])

  const fileContents = createMemo(() => local.file, undefined, { equals: sameFileContents })
  const highlighted = createMemo(() => highlightInputAllowed(fileContents().contents))

  const file = createMemo(() =>
    highlighted()
      ? new File<T>(
          {
            ...createDefaultOptions<T>("unified"),
            ...others,
          },
          getWorkerPool("unified"),
        )
      : undefined,
  )

  const getRoot = () => {
    const host = container.querySelector("diffs-container")
    if (!(host instanceof HTMLElement)) return

    const root = host.shadowRoot
    if (!root) return

    return root
  }

  const handleMouseUp = () => {
    if (props.enableLineSelection !== true) return

    const root = getRoot()
    if (!root) return

    const selection = window.getSelection()
    if (!selection || selection.isCollapsed) return

    const anchor = selection.anchorNode
    const focus = selection.focusNode
    if (!anchor || !focus) return
    if (!root.contains(anchor) || !root.contains(focus)) return

    const start = findLineNumber(anchor)
    const end = findLineNumber(focus)
    if (start === undefined || end === undefined) return

    const startSide = findSide(anchor)
    const endSide = findSide(focus)
    const side = startSide ?? endSide

    const range: SelectedLineRange = {
      start,
      end,
    }

    if (side) range.side = side
    if (endSide && side && endSide !== side) range.endSide = endSide

    file()?.setSelectedLines(range)
  }

  // Value-stable gates: streaming projections rebuild wrapper objects around
  // unchanged file contents and render ranges. The equality memos stop that
  // churn from re-running the render effect, which would otherwise wipe and
  // rebuild the pierre view on every projection (same pattern as
  // DiffPatch.patchText).
  const renderRange = createMemo(() => local.renderRange, undefined, { equals: sameRenderRange })

  createEffect(() => {
    const current = file()

    onCleanup(() => {
      current?.cleanUp()
    })
  })

  createEffect(() => {
    container.innerHTML = ""
    const current = file()
    if (!current) {
      const plain = document.createElement("pre")
      const range = renderRange()
      const wrap = (others.overflow ?? createDefaultOptions<T>("unified").overflow) === "wrap"
      plain.textContent = plainFileRange(fileContents().contents, range)
      plain.style.margin = "0"
      plain.style.whiteSpace = wrap ? "pre-wrap" : "pre"
      plain.style.overflowWrap = wrap ? "anywhere" : "normal"
      plain.style.overflowX = "auto"
      const nodes: HTMLElement[] = [plain]
      if (range && !others.disableVirtualizationBuffers) {
        for (const [side, height] of [
          ["before", range.bufferBefore],
          ["after", range.bufferAfter],
        ] as const) {
          if (height <= 0) continue
          const buffer = document.createElement("div")
          buffer.dataset.virtualizerBuffer = side
          buffer.style.height = `${height}px`
          buffer.style.contain = "strict"
          if (side === "before") nodes.unshift(buffer)
          else nodes.push(buffer)
        }
      }
      container.replaceChildren(...nodes)
      return
    }
    current.render({
      file: fileContents(),
      lineAnnotations: local.annotations,
      containerWrapper: container,
      renderRange: renderRange(),
    })
  })

  createEffect(() => {
    file()?.setSelectedLines(local.selectedLines ?? null)
  })

  createEffect(() => {
    if (props.enableLineSelection !== true) return

    container.addEventListener("mouseup", handleMouseUp)

    onCleanup(() => {
      container.removeEventListener("mouseup", handleMouseUp)
    })
  })

  return (
    <div
      data-component="code"
      style={styleVariables}
      classList={{
        ...(local.classList || {}),
        [local.class ?? ""]: !!local.class,
      }}
      ref={container}
    />
  )
}
