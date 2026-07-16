import { createMemo, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLingui } from "@lingui/solid"
import { getDirectory, getFilename } from "@ericsanchezok/synergy-util/path"
import { DiffChanges } from "./diff-changes"
import { FileIcon } from "./file-icon"
import { Icon } from "./icon"
import { getSemanticIcon } from "./semantic-icon"
import { TURN_CHANGE_DESC } from "./tool-title-descriptors"
import {
  turnChangeSummaryHiddenCount,
  turnChangeSummaryTitle,
  turnChangeSummaryToggleLabel,
  turnChangeSummaryVisibleDiffs,
  type TurnChangeSummaryDiff,
} from "./turn-change-summary-panel-model"
export type { TurnChangeSummaryDiff } from "./turn-change-summary-panel-model"

export type TurnChangeSummaryPanelProps = {
  diffs: TurnChangeSummaryDiff[]
  previewLimit?: number
  onReviewRequested: () => void
  onFileSelected: (file: string) => void
}

export function TurnChangeSummaryPanel(props: TurnChangeSummaryPanelProps) {
  const { _ } = useLingui()
  const [store, setStore] = createStore({ expanded: false })
  const previewLimit = () => props.previewLimit ?? 3
  const hiddenCount = createMemo(() => turnChangeSummaryHiddenCount(props.diffs, previewLimit()))
  const visibleDiffs = createMemo(() =>
    turnChangeSummaryVisibleDiffs(props.diffs, { expanded: store.expanded, previewLimit: previewLimit() }),
  )
  const title = createMemo(() => turnChangeSummaryTitle(props.diffs.length))

  return (
    <section data-component="turn-change-summary-panel" aria-label={title()}>
      <div data-slot="turn-change-summary-header">
        <div data-slot="turn-change-summary-title-group">
          <span data-slot="turn-change-summary-icon" aria-hidden="true">
            <Icon name={getSemanticIcon("command.review")} size="small" />
          </span>
          <div data-slot="turn-change-summary-title-copy">
            <div data-slot="turn-change-summary-title">{title()}</div>
            <DiffChanges changes={props.diffs} />
          </div>
        </div>
        <button type="button" data-slot="turn-change-summary-review" onClick={props.onReviewRequested}>
          {_(TURN_CHANGE_DESC.reviewChanges)}
        </button>
      </div>
      <div data-slot="turn-change-summary-list">
        <For each={visibleDiffs()}>
          {(diff) => (
            <button type="button" data-slot="turn-change-summary-row" onClick={() => props.onFileSelected(diff.file)}>
              <span data-slot="turn-change-summary-file-info">
                <FileIcon node={{ path: diff.file, type: "file" }} data-slot="turn-change-summary-file-icon" />
                <span data-slot="turn-change-summary-file-path">
                  <Show when={diff.file.includes("/")}>
                    <span data-slot="turn-change-summary-directory">{getDirectory(diff.file)}&lrm;</span>
                  </Show>
                  <span data-slot="turn-change-summary-filename">{getFilename(diff.file)}</span>
                </span>
              </span>
              <span data-slot="turn-change-summary-row-actions">
                <Show when={diff.binary}>
                  <span data-slot="turn-change-summary-binary">{_(TURN_CHANGE_DESC.binary)}</span>
                </Show>
                <DiffChanges changes={diff} />
              </span>
            </button>
          )}
        </For>
      </div>
      <Show when={hiddenCount() > 0 || store.expanded}>
        <button
          type="button"
          data-slot="turn-change-summary-toggle"
          aria-expanded={store.expanded}
          onClick={() => setStore("expanded", (value) => !value)}
        >
          {turnChangeSummaryToggleLabel({ expanded: store.expanded, hiddenCount: hiddenCount() })}
        </button>
      </Show>
    </section>
  )
}
