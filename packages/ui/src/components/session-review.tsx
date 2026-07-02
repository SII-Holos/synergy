import { Accordion } from "./accordion"
import { Button } from "./button"
import { RadioGroup } from "./radio-group"
import { DiffChanges } from "./diff-changes"
import { FileIcon } from "./file-icon"
import { Icon } from "./icon"
import { StickyAccordionHeader } from "./sticky-accordion-header"
import { getDirectory, getFilename } from "@ericsanchezok/synergy-util/path"
import { For, Match, Show, Switch, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { type FileDiff } from "@ericsanchezok/synergy-sdk"
import { PreloadMultiFileDiffResult } from "@pierre/diffs/ssr"

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
  onViewFile?: (file: string) => void
}

export const SessionReview = (props: SessionReviewProps) => {
  const [store, setStore] = createStore({
    open: props.diffs.length > 10 ? [] : props.diffs.map((d) => d.file),
  })

  const open = () => props.open ?? store.open
  const diffStyle = () => props.diffStyle ?? (props.split ? "split" : "unified")

  const handleChange = (open: string[]) => {
    props.onOpenChange?.(open)
    if (props.open !== undefined) return
    setStore("open", open)
  }

  const handleExpandOrCollapseAll = () => {
    const next = open().length > 0 ? [] : props.diffs.map((d) => d.file)
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
        <div data-slot="session-review-title">Session changes</div>
        <div data-slot="session-review-actions">
          <Show when={props.onDiffStyleChange}>
            <RadioGroup
              options={["unified", "split"] as const}
              current={diffStyle()}
              value={(style) => style}
              label={(style) => (style === "unified" ? "Unified" : "Split")}
              onSelect={(style) => style && props.onDiffStyleChange?.(style)}
            />
          </Show>
          <Button size="normal" icon="grip-vertical" onClick={handleExpandOrCollapseAll}>
            <Switch>
              <Match when={open().length > 0}>Collapse all</Match>
              <Match when={true}>Expand all</Match>
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
              <Accordion.Item value={diff.file} data-slot="session-review-accordion-item">
                <StickyAccordionHeader>
                  <Accordion.Trigger>
                    <div data-slot="session-review-trigger-content">
                      <div data-slot="session-review-file-info">
                        <FileIcon node={{ path: diff.file, type: "file" }} />
                        <div data-slot="session-review-file-name-container">
                          <Show when={diff.file.includes("/")}>
                            <span data-slot="session-review-directory">{getDirectory(diff.file)}&lrm;</span>
                          </Show>
                          <span data-slot="session-review-filename">{getFilename(diff.file)}</span>
                          <Show when={props.onViewFile}>
                            <button
                              data-slot="session-review-view-button"
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation()
                                props.onViewFile?.(diff.file)
                              }}
                            >
                              <Icon name="eye" size="small" />
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
                  <DiffPreview diff={diff} />
                </Accordion.Content>
              </Accordion.Item>
            )}
          </For>
        </Accordion>
      </div>
    </div>
  )
}

function DiffPreview(props: { diff: FileDiff }) {
  return (
    <div data-component="session-review-preview">
      <div class="text-12-regular text-text-weak">
        {props.diff.beforeBytes ?? 0} bytes to {props.diff.afterBytes ?? 0} bytes
        <Show when={props.diff.truncated}> - preview truncated</Show>
      </div>
      <Show
        when={props.diff.preview}
        fallback={<div class="text-12-regular text-text-weaker">No text preview available.</div>}
      >
        {(preview) => (
          <pre class="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-surface-subtle p-3 text-12-regular text-text-base">
            {preview()}
          </pre>
        )}
      </Show>
    </div>
  )
}
