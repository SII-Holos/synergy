import { Accordion } from "./accordion"
import { Button } from "./button"
import { RadioGroup } from "./radio-group"
import { DiffChanges } from "./diff-changes"
import { DiffPreview } from "./tool/diff-preview"
import { DiffPatchGate } from "./diff-patch"
import { FileIcon } from "./file-icon"
import { Icon } from "./icon"
import { StickyAccordionHeader } from "./sticky-accordion-header"
import { getDirectory, getFilename } from "@ericsanchezok/synergy-util/path"
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  on,
  onCleanup,
  onMount,
  Match,
  Show,
  Switch,
  type JSX,
} from "solid-js"
import { createStore } from "solid-js/store"
import { Virtualizer, type VirtualizerHandle } from "virtua/solid"
import { type FileDiff } from "@ericsanchezok/synergy-sdk"
import { PreloadMultiFileDiffResult } from "@pierre/diffs/ssr"
import { getSemanticIcon } from "./semantic-icon"
import { useLingui } from "@lingui/solid"
import { SESSION_REVIEW_DESC } from "./tool-title-descriptors"
import { reviewFileKey } from "./session-review-model"
import { readSelectionElements } from "../utils/selection"
export { reviewFileKey } from "./session-review-model"

export type SessionReviewDiffStyle = "unified" | "split"
export type SessionReviewPosition = { key: string; offset: number }

export interface SessionReviewProps {
  split?: boolean
  diffStyle?: SessionReviewDiffStyle
  onDiffStyleChange?: (diffStyle: SessionReviewDiffStyle) => void
  open?: string[]
  onOpenChange?: (open: string[]) => void
  scrollRef?: (el: HTMLDivElement) => void
  onScroll?: JSX.EventHandlerUnion<HTMLDivElement, Event>
  class?: string
  classList?: Record<string, boolean | undefined>
  classes?: { root?: string; header?: string; container?: string }
  title?: string
  onRestoreFile?: (diff: FileDiff) => void
  loadDiff?: (diff: FileDiff, signal: AbortSignal, retry?: boolean) => Promise<FileDiff>
  actions?: JSX.Element
  notice?: JSX.Element
  recordingIncomplete?: boolean
  diffs: (FileDiff & { preloaded?: PreloadMultiFileDiffResult<unknown, undefined> })[]
  onViewFile?: (file: string, diff: FileDiff) => void
  canViewFile?: (diff: FileDiff) => boolean
  selectedFile?: string
  initialPosition?: SessionReviewPosition
  onPositionChange?: (position: SessionReviewPosition) => void
}

export const SessionReview = (props: SessionReviewProps) => {
  const { _ } = useLingui()
  const [store, setStore] = createStore({
    open: props.diffs.length > 10 ? [] : props.diffs.map(reviewFileKey),
  })

  const open = () => props.open ?? store.open
  const diffStyle = () => props.diffStyle ?? (props.split ? "split" : "unified")
  // Provenance: https://github.com/inokawa/virtua/blob/0.42.3/src/solid/Virtualizer.tsx
  // Local adaptation: bounded accordion rows retain file identity, keyboard navigation and active selections.
  const indices = createMemo(() => new Map(props.diffs.map((diff, index) => [reviewFileKey(diff), index])))
  const [mounted, setMounted] = createSignal(false)
  const [virtual, setVirtual] = createSignal<VirtualizerHandle>()
  const [margin, setMargin] = createSignal(0)
  const [kept, setKept] = createSignal<string[]>([])
  const [restoring, setRestoring] = createSignal(
    props.initialPosition && indices().has(props.initialPosition.key) ? props.initialPosition : undefined,
  )
  const keptIndices = createMemo(() =>
    [...new Set([...kept(), ...(restoring() ? [restoring()!.key] : [])])].flatMap((key) => indices().get(key) ?? []),
  )
  let root!: HTMLDivElement
  let container!: HTMLDivElement
  let header!: HTMLDivElement
  let observer: ResizeObserver | undefined
  let anchor: HTMLElement | undefined
  const stopRestoring = () => {
    setRestoring(undefined)
    if (anchor) observer?.unobserve(anchor)
    anchor = undefined
  }
  const restorePosition = () => {
    const position = restoring()
    const index = position && indices().get(position.key)
    if (position && index !== undefined) virtual()?.restoreToIndex(index, position.offset)
  }
  const rememberPosition = () => {
    const view = virtual()
    if (!view || !root.isConnected) return
    const index = view.findStartIndex()
    const diff = props.diffs[index]
    if (!diff) return
    props.onPositionChange?.(
      restoring() ?? { key: reviewFileKey(diff), offset: root.scrollTop - margin() - view.getItemOffset(index) },
    )
  }
  let focusTarget: string | undefined
  let focusFrame: number | undefined
  const focusRow = (attempt = 0) => {
    if (focusFrame !== undefined) cancelAnimationFrame(focusFrame)
    focusFrame = undefined
    if (!focusTarget || !root.isConnected) return
    if (!indices().has(focusTarget)) {
      focusTarget = undefined
      return
    }
    const trigger = root.querySelector<HTMLElement>(
      `[data-file="${CSS.escape(focusTarget)}"] [data-slot="accordion-trigger"]`,
    )
    trigger?.focus({ preventScroll: true })
    if (trigger && document.activeElement === trigger) focusTarget = undefined
    else if (attempt < 5) focusFrame = requestAnimationFrame(() => focusRow(attempt + 1))
  }
  const selected = createMemo(() => (indices().has(props.selectedFile ?? "") ? props.selectedFile : undefined))
  let initialSelection = true
  createEffect(
    on(
      () => [virtual(), selected()] as const,
      ([view, key]) => {
        if (!view) return
        if (initialSelection && restoring()) {
          initialSelection = false
          const position = restoring()!
          view.scrollToIndex(indices().get(position.key)!, { align: "start", offset: position.offset })
          return
        }
        initialSelection = false
        if (!key) return
        stopRestoring()
        view.scrollToIndex(indices().get(key)!, { align: "nearest" })
      },
    ),
  )
  onMount(() => {
    const measure = () =>
      setMargin(container.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop)
    observer = new ResizeObserver(() => {
      measure()
      restorePosition()
    })
    observer.observe(root)
    observer.observe(header)
    const structure = new MutationObserver(measure)
    structure.observe(root, { childList: true })
    measure()
    const pin = (event?: Event) => {
      const rows = new Set<string>()
      const add = (node: Node | null) => {
        const element = node instanceof Element ? node : node?.parentElement
        const row = element?.closest<HTMLElement>("[data-file]")
        const key = row && root.contains(row) ? row.dataset.file : undefined
        if (key && indices().has(key)) rows.add(key)
      }
      const active = event?.type === "focusout" ? (event as FocusEvent).relatedTarget : document.activeElement
      add(active instanceof Node ? active : null)
      for (const row of readSelectionElements(root, "[data-file]")) add(row)
      setKept((previous) =>
        previous.length === rows.size && previous.every((index) => rows.has(index)) ? previous : [...rows],
      )
    }
    const navigate = (event: KeyboardEvent) => {
      const trigger = event.target instanceof Element ? event.target.closest('[data-slot="accordion-trigger"]') : null
      const key = trigger?.closest<HTMLElement>("[data-file]")?.dataset.file
      const current = key ? indices().get(key) : undefined
      if (current === undefined || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      const index =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? props.diffs.length - 1
            : event.key === "ArrowDown"
              ? Math.min(current + 1, props.diffs.length - 1)
              : event.key === "ArrowUp"
                ? Math.max(0, current - 1)
                : undefined
      if (index === undefined) return
      event.preventDefault()
      event.stopPropagation()
      focusTarget = reviewFileKey(props.diffs[index]!)
      setKept((previous) => [...new Set([...previous, focusTarget!])])
      virtual()?.scrollToIndex(index, { align: "nearest" })
      queueMicrotask(focusRow)
    }
    root.addEventListener("keydown", navigate, true)
    root.addEventListener("scroll", rememberPosition, { passive: true })
    for (const event of ["wheel", "touchstart", "pointerdown", "keydown"])
      root.addEventListener(event, stopRestoring, { passive: true, capture: true })
    document.addEventListener("focusin", pin)
    document.addEventListener("focusout", pin)
    document.addEventListener("selectionchange", pin)
    setMounted(true)
    onCleanup(() => {
      rememberPosition()
      if (focusFrame !== undefined) cancelAnimationFrame(focusFrame)
      observer?.disconnect()
      structure.disconnect()
      root.removeEventListener("keydown", navigate, true)
      root.removeEventListener("scroll", rememberPosition)
      for (const event of ["wheel", "touchstart", "pointerdown", "keydown"])
        root.removeEventListener(event, stopRestoring, true)
      document.removeEventListener("focusin", pin)
      document.removeEventListener("focusout", pin)
      document.removeEventListener("selectionchange", pin)
    })
  })

  const handleChange = (open: string[]) => {
    props.onOpenChange?.(open)
    if (props.open !== undefined) return
    setStore("open", open)
  }

  const handleExpandOrCollapseAll = () => {
    const next = open().length > 0 ? [] : props.diffs.map(reviewFileKey)
    handleChange(next)
  }

  return (
    <div
      data-component="session-review"
      ref={(element) => {
        root = element
        props.scrollRef?.(element)
      }}
      onScroll={props.onScroll}
      classList={{
        ...(props.classList ?? {}),
        [props.classes?.root ?? ""]: !!props.classes?.root,
        [props.class ?? ""]: !!props.class,
      }}
    >
      {props.notice}
      <div
        ref={header}
        data-slot="session-review-header"
        classList={{
          [props.classes?.header ?? ""]: !!props.classes?.header,
        }}
      >
        <div data-slot="session-review-title">{props.title ?? _(SESSION_REVIEW_DESC.title)}</div>
        <div data-slot="session-review-actions">
          <Show when={props.onDiffStyleChange}>
            <RadioGroup
              options={["unified", "split"] as const}
              current={diffStyle()}
              value={(style) => style}
              label={(style) => (style === "unified" ? _(SESSION_REVIEW_DESC.unified) : _(SESSION_REVIEW_DESC.split))}
              onSelect={(style) => style && props.onDiffStyleChange?.(style)}
            />
          </Show>
          <Button
            size="normal"
            icon={getSemanticIcon(open().length ? "action.collapse" : "action.expand")}
            disabled={!props.diffs.length}
            onClick={handleExpandOrCollapseAll}
          >
            <Switch>
              <Match when={open().length > 0}>{_(SESSION_REVIEW_DESC.collapseAll)}</Match>
              <Match when={true}>{_(SESSION_REVIEW_DESC.expandAll)}</Match>
            </Switch>
          </Button>
          {props.actions}
        </div>
      </div>
      <div
        ref={container}
        data-slot="session-review-container"
        classList={{
          [props.classes?.container ?? ""]: !!props.classes?.container,
        }}
      >
        <Show when={!props.diffs.length && !props.recordingIncomplete}>
          <div data-slot="session-review-empty" role="status">
            <Icon name={getSemanticIcon("command.review")} />
            {_({ id: "ui.sessionReview.noChanges", message: "No changes" })}
          </div>
        </Show>
        <Accordion multiple value={open()} onChange={handleChange}>
          <Show when={mounted()}>
            <Virtualizer
              ref={setVirtual}
              data={[...indices().keys()]}
              itemKey={(key) => key}
              scrollRef={root}
              startMargin={margin()}
              overscan={4}
              keepMounted={keptIndices()}
            >
              {(key, index) => (
                <Show when={props.diffs[indices().get(key) ?? -1]}>
                  {(diff) => (
                    <Accordion.Item
                      ref={(element: HTMLDivElement) => {
                        if (restoring()?.key === key) {
                          anchor = element
                          observer?.observe(element)
                        }
                        queueMicrotask(focusRow)
                      }}
                      value={key}
                      data-slot="session-review-accordion-item"
                      data-file={key}
                      data-selected={props.selectedFile === key ? "true" : undefined}
                    >
                      <StickyAccordionHeader>
                        <div data-slot="session-review-file-header">
                          <Accordion.Trigger>
                            <div data-slot="session-review-trigger-content">
                              <div data-slot="session-review-file-info">
                                <FileIcon node={{ path: diff().file, type: "file" }} />
                                <div data-slot="session-review-file-name-container">
                                  <Show when={diff().workspace?.root ?? diff().legacyRoot}>
                                    {(root) => <span data-slot="session-review-directory">{root()} / </span>}
                                  </Show>
                                  <Show when={diff().file.includes("/")}>
                                    <span data-slot="session-review-directory">{getDirectory(diff().file)}&lrm;</span>
                                  </Show>
                                  <span data-slot="session-review-filename">{getFilename(diff().file)}</span>
                                  <Show when={diff().operationID}>
                                    <span data-slot="session-review-operation">
                                      {_({ ...SESSION_REVIEW_DESC.operation, values: { number: index() + 1 } })}
                                    </span>
                                  </Show>
                                </div>
                              </div>
                              <div data-slot="session-review-trigger-actions">
                                <DiffChanges changes={diff()} />
                                <Icon name="grip-vertical" size="small" />
                              </div>
                            </div>
                          </Accordion.Trigger>
                          <Show when={props.onViewFile}>
                            <button
                              data-slot="session-review-view-button"
                              type="button"
                              disabled={props.canViewFile?.(diff()) === false}
                              aria-label={_(SESSION_REVIEW_DESC.viewFile)}
                              title={_(
                                props.canViewFile?.(diff()) === false
                                  ? SESSION_REVIEW_DESC.historicalBinding
                                  : SESSION_REVIEW_DESC.viewFile,
                              )}
                              onClick={() => {
                                if (props.canViewFile?.(diff()) !== false) props.onViewFile?.(diff().file, diff())
                              }}
                            >
                              <Icon name={getSemanticIcon("action.view")} size="small" />
                            </button>
                          </Show>
                        </div>
                      </StickyAccordionHeader>
                      <Accordion.Content data-slot="session-review-accordion-content">
                        <Show when={open().includes(key)}>
                          <ReviewFileBody diff={diff()} diffStyle={diffStyle()} loadDiff={props.loadDiff} />
                          <Show when={props.onRestoreFile && diff().workspace}>
                            <Button variant="ghost" onClick={() => props.onRestoreFile?.(diff())}>
                              {_({ id: "ui.sessionReview.undoFile", message: "Undo this file" })}
                            </Button>
                          </Show>
                        </Show>
                      </Accordion.Content>
                    </Accordion.Item>
                  )}
                </Show>
              )}
            </Virtualizer>
          </Show>
        </Accordion>
      </div>
    </div>
  )
}

function ReviewFileBody(props: {
  diff: FileDiff
  diffStyle: SessionReviewDiffStyle
  loadDiff?: SessionReviewProps["loadDiff"]
}) {
  const { _ } = useLingui()
  const controller = new AbortController()
  onCleanup(() => controller.abort())
  const source = createMemo(() =>
    props.loadDiff && (props.diff.truncated || (!props.diff.patch && !props.diff.preview && !props.diff.binary))
      ? props.diff
      : undefined,
  )
  const [full, { refetch }] = createResource<FileDiff, FileDiff>(source, (diff, { refetching }) =>
    props.loadDiff!(diff, controller.signal, Boolean(refetching)),
  )
  const diff = () => (!source() || full.error ? props.diff : (full.latest ?? props.diff))
  return (
    <>
      <Show when={full.loading}>
        <p data-slot="session-review-file-status" role="status">
          {_({ id: "ui.sessionReview.loadingFile", message: "Loading historical file content…" })}
        </p>
      </Show>
      <Show when={full.error}>
        <Button variant="ghost" onClick={() => void refetch()}>
          {_({ id: "ui.sessionReview.retryFile", message: "Retry loading historical content" })}
        </Button>
      </Show>
      <Show when={!full.loading}>
        <DiffPatchGate
          patch={diff().patch}
          diffStyle={props.diffStyle}
          fallback={<DiffPreview diff={diff()} variant="review" />}
        />
      </Show>
    </>
  )
}
