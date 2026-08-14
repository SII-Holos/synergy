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

  const file = createMemo(
    () =>
      new File<T>(
        {
          ...createDefaultOptions<T>("unified"),
          ...others,
        },
        getWorkerPool("unified"),
      ),
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

    file().setSelectedLines(range)
  }

  // Value-stable gates: streaming projections rebuild wrapper objects around
  // unchanged file contents and render ranges. The equality memos stop that
  // churn from re-running the render effect, which would otherwise wipe and
  // rebuild the pierre view on every projection (same pattern as
  // DiffPatch.patchText).
  const fileContents = createMemo(() => local.file, undefined, { equals: sameFileContents })
  const renderRange = createMemo(() => local.renderRange, undefined, { equals: sameRenderRange })

  createEffect(() => {
    const current = file()

    onCleanup(() => {
      current.cleanUp()
    })
  })

  createEffect(() => {
    container.innerHTML = ""
    file().render({
      file: fileContents(),
      lineAnnotations: local.annotations,
      containerWrapper: container,
      renderRange: renderRange(),
    })
  })

  createEffect(() => {
    file().setSelectedLines(local.selectedLines ?? null)
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
