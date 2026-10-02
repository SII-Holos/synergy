import { createEffect, createMemo, on, onCleanup, Show, For, type JSX } from "solid-js"
import { SessionReview, reviewFileKey } from "@ericsanchezok/synergy-ui/session-review"
import type { FileDiff, UserMessage } from "@ericsanchezok/synergy-sdk/client"
import { useLingui } from "@lingui/solid"
import type { MessageDescriptor } from "@lingui/core"
import type { useLayout } from "@/context/layout"
import { computeReviewOpenForSelectedFile } from "./review-open-model"
import { translateDescriptor } from "@/locales/translate"

type DiffStyle = "unified" | "split"
type DiffState = NonNullable<UserMessage["summary"]>["diffState"]
const recordingErrors: Record<Extract<DiffState, { status: "error" }>["code"], MessageDescriptor> = {
  incomplete: { id: "session.review.recording.incomplete", message: "File change recording is incomplete." },
  timeout: { id: "session.review.recording.timeout", message: "File change recording timed out." },
  git_failure: {
    id: "session.review.recording.gitFailure",
    message: "File change recording could not read the repository.",
  },
  unknown: { id: "session.review.recording.failed", message: "File change recording failed." },
}

const issueMessages = {
  baseline_unavailable: { id: "session.review.issue.baseline", message: "The starting snapshot could not be saved." },
  capture_failed: { id: "session.review.issue.capture", message: "The ending snapshot could not be saved." },
  interrupted: {
    id: "session.review.issue.interrupted",
    message: "Recording was interrupted before a checkpoint was saved.",
  },
  legacy_range: {
    id: "session.review.issue.legacy",
    message: "This history retains operation snapshots, but has no complete turn baseline.",
  },
  comparison_failed: { id: "session.review.issue.comparison", message: "Saved file versions could not be compared." },
  size_limit: { id: "session.review.issue.size", message: "This file exceeded the snapshot size limit." },
  read_failed: { id: "session.review.issue.read", message: "This file could not be read consistently." },
} satisfies Record<string, MessageDescriptor>

export interface SessionReviewTabProps {
  diffs: () => FileDiff[]
  diffState?: () => DiffState
  diffIssues?: () => NonNullable<UserMessage["summary"]>["diffIssues"]
  title?: string
  actions?: JSX.Element
  onRestoreFile?: (diff: FileDiff) => void
  loadDiff?: (diff: FileDiff, signal: AbortSignal) => Promise<FileDiff>
  workspace?: () => { id: string; generation: number; path: string } | null
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
  const { _, i18n } = useLingui()
  const recordingNotice = () => {
    const state = props.diffState?.()
    if (state?.status === "pending")
      return _({ id: "session.review.recording.pending", message: "Recording file changes…" })
    if (state?.status === "error" || state?.status === "partial")
      return translateDescriptor(recordingErrors[state.code], i18n())
  }
  const canViewFile = (diff: FileDiff) => {
    const current = props.workspace?.()
    return Boolean(
      current &&
        diff.workspace &&
        diff.workspace.id === current.id &&
        diff.workspace.generation === current.generation &&
        diff.workspace.root === current.path,
    )
  }
  const selectedKey = createMemo(() => {
    const selected = props.selectedFile?.()
    if (!selected) return
    const exact = props.diffs().find((diff) => reviewFileKey(diff) === selected)
    if (exact) return reviewFileKey(exact)
    const matches = props.diffs().filter((diff) => diff.file === selected)
    const match = matches.find(canViewFile) ?? (matches.length === 1 ? matches[0] : undefined)
    return match ? reviewFileKey(match) : undefined
  })
  let scroll: HTMLDivElement | undefined
  let frame: number | undefined
  let pending: { x: number; y: number } | undefined

  const focusSelectedFileRow = (retries = 0) => {
    const selected = selectedKey()
    if (!selected) return

    const row = scroll?.querySelector<HTMLElement>(`[data-slot="accordion-item"][data-file="${CSS.escape(selected)}"]`)
    if (!row) {
      if (retries < 5) requestAnimationFrame(() => focusSelectedFileRow(retries + 1))
      return
    }
    row.scrollIntoView({ block: "nearest" })
    row.querySelector<HTMLElement>("[data-slot='accordion-trigger']")?.focus({ preventScroll: true })
  }

  const openSelectedFile = () => {
    const selected = selectedKey()
    if (!selected) return
    if (!props.diffs().some((diff) => reviewFileKey(diff) === selected)) return

    const current = props.view().review.open() ?? []
    const next = computeReviewOpenForSelectedFile(selected, props.diffs().map(reviewFileKey), current)
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

  createEffect(on(() => [selectedKey(), props.diffs().map(reviewFileKey).join("\u0000")] as const, openSelectedFile))

  onCleanup(() => {
    if (frame === undefined) return
    cancelAnimationFrame(frame)
  })

  return (
    <SessionReview
      title={props.title}
      actions={props.actions}
      onRestoreFile={props.onRestoreFile}
      loadDiff={props.loadDiff}
      notice={
        <Show when={recordingNotice()}>
          <div data-slot="review-recording-notice" role="status" class="px-6 py-3 text-13-regular text-text-weak">
            <p>{recordingNotice()}</p>
            <Show when={props.diffState?.()?.status === "error"}>
              <p>
                {_({
                  id: "session.review.recording.limits",
                  message:
                    "This does not mean no files changed. Available changes are shown below; unrecorded changes cannot be reviewed or used for file restoration.",
                })}
              </p>
            </Show>
            <For each={props.diffIssues?.()}>
              {(issue) => {
                const source = [issue.workspace?.root || issue.workspace?.id, issue.file].filter(Boolean).join("/")
                return (
                  <p>
                    {source ? `${source}: ` : ""}
                    {translateDescriptor(issueMessages[issue.code], i18n())}
                  </p>
                )
              }}
            </For>
          </div>
        </Show>
      }
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
      canViewFile={canViewFile}
      onViewFile={(file, diff) => {
        if (canViewFile(diff)) props.onViewFile?.(file)
      }}
      selectedFile={selectedKey()}
    />
  )
}
