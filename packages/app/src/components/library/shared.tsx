import { Show } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import type { RewardsInfo } from "@ericsanchezok/synergy-sdk/client"

export type View = "stats" | "memory" | "experience" | "skill"

export type MemorySortKey = "newest" | "oldest" | "relevance"
export type ExperienceSortKey = "newest" | "oldest" | "relevance" | "reward" | "qvalue" | "visits"
export type ExperienceFilter = "all" | "scope" | "session"

export type MemoryCategory =
  | "user"
  | "self"
  | "relationship"
  | "interaction"
  | "workflow"
  | "coding"
  | "writing"
  | "asset"
  | "insight"
  | "knowledge"
  | "personal"
  | "general"

export type MemoryRecallMode = "always" | "contextual" | "search_only"

export const MEMORY_CATEGORIES: MemoryCategory[] = [
  "user",
  "self",
  "relationship",
  "interaction",
  "workflow",
  "coding",
  "writing",
  "asset",
  "insight",
  "knowledge",
  "personal",
  "general",
]

export const categoryLabels: Record<MemoryCategory, string> = {
  user: "User",
  self: "Self",
  relationship: "Relationship",
  interaction: "Interaction",
  workflow: "Workflow",
  coding: "Coding",
  writing: "Writing",
  asset: "Asset",
  insight: "Insight",
  knowledge: "Knowledge",
  personal: "Personal",
  general: "General",
}

export const categoryColors: Record<MemoryCategory, string> = {
  user: "bg-[oklch(0.93_0.03_250)] text-[oklch(0.55_0.08_250)]",
  self: "bg-[oklch(0.93_0.03_290)] text-[oklch(0.55_0.08_290)]",
  relationship: "bg-[oklch(0.93_0.03_350)] text-[oklch(0.55_0.08_350)]",
  interaction: "bg-[oklch(0.93_0.03_40)] text-[oklch(0.55_0.08_40)]",
  workflow: "bg-[oklch(0.93_0.03_110)] text-[oklch(0.55_0.08_110)]",
  coding: "bg-[oklch(0.93_0.03_210)] text-[oklch(0.55_0.08_210)]",
  writing: "bg-[oklch(0.93_0.03_20)] text-[oklch(0.55_0.08_20)]",
  asset: "bg-[oklch(0.93_0.03_160)] text-[oklch(0.55_0.08_160)]",
  insight: "bg-[oklch(0.93_0.03_270)] text-[oklch(0.55_0.08_270)]",
  knowledge: "bg-[oklch(0.93_0.03_180)] text-[oklch(0.55_0.08_180)]",
  personal: "bg-[oklch(0.93_0.03_80)] text-[oklch(0.55_0.08_80)]",
  general: "bg-surface-inset-base text-text-weak",
}

export const recallModeLabels: Record<MemoryRecallMode, string> = {
  always: "Always",
  contextual: "Contextual",
  search_only: "Search only",
}

export const recallModeColors: Record<MemoryRecallMode, string> = {
  always: "workbench-selected-surface text-text-strong ring-border-base/20",
  contextual: "bg-surface-positive-base/10 text-text-positive-base",
  search_only: "bg-surface-inset-base text-text-weaker",
}

export const memorySortLabels: Record<MemorySortKey, string> = {
  newest: "Newest",
  oldest: "Oldest",
  relevance: "Relevance",
}

export const experienceSortLabels: Record<ExperienceSortKey, string> = {
  newest: "Newest",
  oldest: "Oldest",
  relevance: "Relevance",
  reward: "Reward",
  qvalue: "Q-value",
  visits: "Most visited",
}

export const DISCRETE_DIMENSIONS: Array<{ key: keyof RewardsInfo; short: string; full: string }> = [
  { key: "outcome", short: "Out", full: "Outcome" },
  { key: "intent", short: "Int", full: "Intent" },
  { key: "execution", short: "Exe", full: "Execution" },
  { key: "orchestration", short: "Orc", full: "Orchestration" },
  { key: "expression", short: "Exp", full: "Expression" },
]

export const libraryShellClass =
  "workbench-panel-surface rounded-[1.2rem] border border-border-base/28 bg-surface-raised-base"

export const libraryInsetClass =
  "workbench-control-surface rounded-[1rem] bg-surface-inset-base ring-1 ring-inset ring-border-base/30"

export const libraryCardBaseClass =
  "workbench-card-surface flex flex-col overflow-hidden rounded-[1.15rem] border border-border-base/28 bg-surface-raised-base transition-colors"

export const libraryCardExpandedClass = "border-border-base/38 bg-surface-raised-base-hover"

export const libraryCardHoverClass = "hover:border-border-base/36 hover:bg-surface-raised-base-hover"

export const libraryActionButtonClass =
  "workbench-control-surface flex items-center gap-1 rounded-full bg-surface-inset-base px-2.5 py-1.5 text-11-medium text-text-weak ring-1 ring-inset ring-border-base/32 transition-colors hover:bg-surface-raised-base-hover hover:text-text-base"

export const libraryMenuClass =
  "workbench-popover-surface z-50 min-w-36 overflow-hidden rounded-[1rem] border border-border-base/32 bg-surface-raised-base p-1.5 outline-none"

export const libraryMetaLabelClass = "text-[10px] font-medium uppercase tracking-[0.16em] text-text-weaker"

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function SelectionBar(props: {
  count: number
  total: number
  deleting: boolean
  onSelectAll: () => void
  onDelete: () => void
  onCancel: () => void
}) {
  return (
    <div class={`flex items-center justify-between gap-3 px-3 py-2.5 ${libraryInsetClass}`}>
      <div class="flex min-w-0 items-center gap-2">
        <span class="text-12-medium text-text-base">
          {props.count} / {props.total} selected
        </span>
        <Show when={props.count < props.total}>
          <button
            type="button"
            class="rounded-full px-2.5 py-1 text-11-medium text-text-base ring-1 ring-inset ring-border-base/35 transition-colors hover:bg-surface-raised-base-hover"
            onClick={props.onSelectAll}
          >
            Select all
          </button>
        </Show>
      </div>
      <div class="flex items-center gap-1.5">
        <Show when={props.count > 0}>
          <button
            type="button"
            classList={{
              "flex items-center gap-1 rounded-full px-3 py-1.5 text-11-medium ring-1 ring-inset transition-all": true,
              "text-text-diff-delete-base ring-text-diff-delete-base/15 hover:bg-text-diff-delete-base/8":
                !props.deleting,
              "text-text-weaker ring-border-base/40 pointer-events-none": props.deleting,
            }}
            onClick={props.onDelete}
            disabled={props.deleting}
          >
            <Show when={props.deleting} fallback={<>Delete ({props.count})</>}>
              <Spinner class="size-3" />
              Deleting...
            </Show>
          </button>
        </Show>
        <button
          type="button"
          class="rounded-full px-3 py-1.5 text-11-medium text-text-weak ring-1 ring-inset ring-border-base/45 transition-all hover:bg-surface-raised-base-hover hover:text-text-base"
          onClick={props.onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
export function LibraryFilterChip(props: { active: boolean; onClick: () => void; children: any }) {
  return (
    <button
      type="button"
      classList={{
        "px-2.5 py-1 rounded-lg text-12-medium transition-colors": true,
        "workbench-selected-surface bg-surface-raised-base-hover text-text-strong": props.active,
        "text-text-weak hover:text-text-base hover:bg-surface-raised-base-hover": !props.active,
      }}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  )
}

export function ViewTab(props: { active: boolean; onClick: () => void; children: any }) {
  return (
    <button
      type="button"
      classList={{
        "flex-1 rounded-[0.8rem] px-3 py-1.5 text-center text-12-medium transition-all duration-200": true,
        "workbench-selected-surface bg-surface-raised-base text-text-strong scale-[1.01] ring-1 ring-inset ring-border-base/32":
          props.active,
        "text-text-weak hover:bg-surface-raised-base-hover hover:text-text-base": !props.active,
      }}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  )
}

export function SelectionCheckbox(props: { selected: boolean }) {
  return (
    <div
      classList={{
        "flex size-4 shrink-0 items-center justify-center rounded-[0.45rem] border ring-1 ring-inset transition-colors": true,
        "border-border-base/55 bg-text-strong text-background-base ring-border-base/20": props.selected,
        "workbench-control-surface border-border-base/40 bg-surface-raised-base text-transparent ring-border-base/25":
          !props.selected,
      }}
    >
      <Show when={props.selected}>
        <Icon name="check" size="small" class="scale-75" />
      </Show>
    </div>
  )
}
