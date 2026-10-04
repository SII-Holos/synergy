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
import { createResource, onCleanup, For, Match, Show, Switch, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { type FileDiff } from "@ericsanchezok/synergy-sdk"
import { PreloadMultiFileDiffResult } from "@pierre/diffs/ssr"
import { getSemanticIcon } from "./semantic-icon"
import { useLingui } from "@lingui/solid"
import { SESSION_REVIEW_DESC } from "./tool-title-descriptors"
import { reviewFileKey } from "./session-review-model"
export { reviewFileKey } from "./session-review-model"

export type SessionReviewDiffStyle = "unified" | "split"

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
  loadDiff?: (diff: FileDiff, signal: AbortSignal) => Promise<FileDiff>
  actions?: JSX.Element
  notice?: JSX.Element
  recordingIncomplete?: boolean
  diffs: (FileDiff & { preloaded?: PreloadMultiFileDiffResult<any> })[]
  onViewFile?: (file: string, diff: FileDiff) => void
  canViewFile?: (diff: FileDiff) => boolean
  selectedFile?: string
}

export const SessionReview = (props: SessionReviewProps) => {
  const { _ } = useLingui()
  const [store, setStore] = createStore({
    open: props.diffs.length > 10 ? [] : props.diffs.map(reviewFileKey),
  })

  const open = () => props.open ?? store.open
  const diffStyle = () => props.diffStyle ?? (props.split ? "split" : "unified")

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
      ref={props.scrollRef}
      onScroll={props.onScroll}
      classList={{
        ...(props.classList ?? {}),
        [props.classes?.root ?? ""]: !!props.classes?.root,
        [props.class ?? ""]: !!props.class,
      }}
    >
      {props.notice}
      <div
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
          <For each={props.diffs}>
            {(diff, index) => (
              <Accordion.Item
                value={reviewFileKey(diff)}
                data-slot="session-review-accordion-item"
                data-file={reviewFileKey(diff)}
                data-selected={props.selectedFile === reviewFileKey(diff) ? "true" : undefined}
              >
                <StickyAccordionHeader>
                  <div data-slot="session-review-file-header">
                    <Accordion.Trigger>
                      <div data-slot="session-review-trigger-content">
                        <div data-slot="session-review-file-info">
                          <FileIcon node={{ path: diff.file, type: "file" }} />
                          <div data-slot="session-review-file-name-container">
                            <Show when={diff.workspace?.root ?? diff.legacyRoot}>
                              {(root) => <span data-slot="session-review-directory">{root()} / </span>}
                            </Show>
                            <Show when={diff.file.includes("/")}>
                              <span data-slot="session-review-directory">{getDirectory(diff.file)}&lrm;</span>
                            </Show>
                            <span data-slot="session-review-filename">{getFilename(diff.file)}</span>
                            <Show when={diff.operationID}>
                              <span data-slot="session-review-operation">
                                {_({ ...SESSION_REVIEW_DESC.operation, values: { number: index() + 1 } })}
                              </span>
                            </Show>
                          </div>
                        </div>
                        <div data-slot="session-review-trigger-actions">
                          <DiffChanges changes={diff} />
                          <Icon name="grip-vertical" size="small" />
                        </div>
                      </div>
                    </Accordion.Trigger>
                    <Show when={props.onViewFile}>
                      <button
                        data-slot="session-review-view-button"
                        type="button"
                        disabled={props.canViewFile?.(diff) === false}
                        aria-label={_(SESSION_REVIEW_DESC.viewFile)}
                        title={_(
                          props.canViewFile?.(diff) === false
                            ? SESSION_REVIEW_DESC.historicalBinding
                            : SESSION_REVIEW_DESC.viewFile,
                        )}
                        onClick={() => {
                          if (props.canViewFile?.(diff) !== false) props.onViewFile?.(diff.file, diff)
                        }}
                      >
                        <Icon name={getSemanticIcon("action.view")} size="small" />
                      </button>
                    </Show>
                  </div>
                </StickyAccordionHeader>
                <Accordion.Content data-slot="session-review-accordion-content">
                  <Show when={open().includes(reviewFileKey(diff))}>
                    <ReviewFileBody diff={diff} diffStyle={diffStyle()} loadDiff={props.loadDiff} />
                    <Show when={props.onRestoreFile && diff.workspace}>
                      <Button variant="ghost" onClick={() => props.onRestoreFile?.(diff)}>
                        {_({ id: "ui.sessionReview.undoFile", message: "Undo this file" })}
                      </Button>
                    </Show>
                  </Show>
                </Accordion.Content>
              </Accordion.Item>
            )}
          </For>
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
  const [full, { refetch }] = createResource(
    () =>
      Boolean(
        props.loadDiff && (props.diff.truncated || (!props.diff.patch && !props.diff.preview && !props.diff.binary)),
      ),
    () => props.loadDiff!(props.diff, controller.signal),
    { initialValue: undefined },
  )
  const diff = () => (full.error ? props.diff : (full.latest ?? props.diff))
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
