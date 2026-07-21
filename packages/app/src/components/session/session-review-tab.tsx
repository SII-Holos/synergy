import { createEffect, on, onCleanup } from "solid-js"
import { SessionReview } from "@ericsanchezok/synergy-ui/session-review"
import type { FileDiff } from "@ericsanchezok/synergy-sdk/client"
import type { useLayout } from "@/context/layout"
import { computeReviewOpenForSelectedFile } from "./review-open-model"

type DiffStyle = "unified" | "split"

export interface SessionReviewTabProps {
  diffs: () => FileDiff[]
  view: () => ReturnType<ReturnType<typeof useLayout>["view"]>
  diffStyle: DiffStyle
  onDiffStyleChange?: (style: DiffStyle) => void
  onViewFile?: (file: string) => void
  selectedFile?: () => string | undefined
  classes?: {
    root?: string
    header?: string
    container?: string
  }
}

export function SessionReviewTab(props: SessionReviewTabProps) {
  let scroll: HTMLDivElement | undefined
  let frame: number | undefined
  let pending: { x: number; y: number } | undefined

  const focusSelectedFileRow = (retries = 0) => {
    const selected = props.selectedFile?.()
    if (!selected) return

    const row = scroll?.querySelector<HTMLElement>(
      `[data-slot="session-review-accordion-item"][data-file="${CSS.escape(selected)}"]`,
    )
    if (!row) {
      if (retries < 5) requestAnimationFrame(() => focusSelectedFileRow(retries + 1))
      return
    }
    row.scrollIntoView({ block: "nearest" })
    row.querySelector<HTMLElement>("[data-slot='accordion-trigger']")?.focus({ preventScroll: true })
  }

  const openSelectedFile = () => {
    const selected = props.selectedFile?.()
    if (!selected) return
    if (!props.diffs().some((diff) => diff.file === selected)) return

    const current = props.view().review.open() ?? []
    const next = computeReviewOpenForSelectedFile(
      selected,
      props.diffs().map((d) => d.file),
      current,
    )
    if (next) {
      props.view().review.setOpen(next)
    }

    requestAnimationFrame(() => focusSelectedFileRow())
  }

  const restoreScroll = (retries = 0) => {
    const el = scroll
    if (!el) return

    const s = props.view().scroll("review")
    if (!s) return

    if (el.scrollHeight <= el.clientHeight && retries < 10) {
      requestAnimationFrame(() => restoreScroll(retries + 1))
      return
    }

    if (el.scrollTop !== s.y) el.scrollTop = s.y
    if (el.scrollLeft !== s.x) el.scrollLeft = s.x
  }

  const handleScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    pending = {
      x: event.currentTarget.scrollLeft,
      y: event.currentTarget.scrollTop,
    }
    if (frame !== undefined) return

    frame = requestAnimationFrame(() => {
      frame = undefined

      const next = pending
      pending = undefined
      if (!next) return

      props.view().setScroll("review", next)
    })
  }

  createEffect(
    on(
      () => props.diffs().length,
      () => {
        requestAnimationFrame(restoreScroll)
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () =>
        [
          props.selectedFile?.(),
          props
            .diffs()
            .map((diff) => diff.file)
            .join("\u0000"),
        ] as const,
      openSelectedFile,
      { defer: true },
    ),
  )

  onCleanup(() => {
    if (frame === undefined) return
    cancelAnimationFrame(frame)
  })

  return (
    <SessionReview
      scrollRef={(el) => {
        scroll = el
        restoreScroll()
      }}
      onScroll={handleScroll}
      open={props.view().review.open()}
      onOpenChange={props.view().review.setOpen}
      classes={{
        root: props.classes?.root ?? "pb-40",
        header: props.classes?.header ?? "px-6",
        container: props.classes?.container ?? "px-6",
      }}
      diffs={props.diffs()}
      diffStyle={props.diffStyle}
      onDiffStyleChange={props.onDiffStyleChange}
      onViewFile={props.onViewFile}
      selectedFile={props.selectedFile?.()}
    />
  )
}
