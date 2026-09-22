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
import { For, Match, Show, Switch, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { type FileDiff } from "@ericsanchezok/synergy-sdk"
import { PreloadMultiFileDiffResult } from "@pierre/diffs/ssr"
import { getSemanticIcon } from "./semantic-icon"
import { useLingui } from "@lingui/solid"
import { SESSION_REVIEW_DESC } from "./tool-title-descriptors"

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
  actions?: JSX.Element
  diffs: (FileDiff & { preloaded?: PreloadMultiFileDiffResult<any> })[]
  onViewFile?: (file: string, diff: FileDiff) => void
  canViewFile?: (diff: FileDiff) => boolean
  selectedFile?: string
}

export function reviewFileKey(diff: FileDiff) {
  return diff.workspace
    ? JSON.stringify([diff.workspace.id, diff.workspace.generation, diff.workspace.root, diff.file])
    : diff.legacyRoot
      ? JSON.stringify(["legacy", diff.legacyRoot, diff.file])
      : diff.file
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
      <div
        data-slot="session-review-header"
        classList={{
          [props.classes?.header ?? ""]: !!props.classes?.header,
        }}
      >
        <div data-slot="session-review-title">{_(SESSION_REVIEW_DESC.title)}</div>
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
          <Button size="normal" icon="grip-vertical" onClick={handleExpandOrCollapseAll}>
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
        <Accordion multiple value={open()} onChange={handleChange}>
          <For each={props.diffs}>
            {(diff) => (
              <Accordion.Item
                value={reviewFileKey(diff)}
                data-slot="session-review-accordion-item"
                data-file={reviewFileKey(diff)}
                data-selected={props.selectedFile === reviewFileKey(diff) ? "true" : undefined}
              >
                <StickyAccordionHeader>
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
                              onClick={(e) => {
                                e.stopPropagation()
                                if (props.canViewFile?.(diff) !== false) props.onViewFile?.(diff.file, diff)
                              }}
                            >
                              <Icon name={getSemanticIcon("action.view")} size="small" />
                            </button>
                          </Show>
                        </div>
                      </div>
                      <div data-slot="session-review-trigger-actions">
                        <DiffChanges changes={diff} />
                        <Icon name="grip-vertical" size="small" />
                      </div>
                    </div>
                  </Accordion.Trigger>
                </StickyAccordionHeader>
                <Accordion.Content data-slot="session-review-accordion-content">
                  <DiffPatchGate
                    patch={diff.patch}
                    diffStyle={diffStyle()}
                    fallback={<DiffPreview diff={diff} variant="review" />}
                  />
                </Accordion.Content>
              </Accordion.Item>
            )}
          </For>
        </Accordion>
      </div>
    </div>
  )
}
