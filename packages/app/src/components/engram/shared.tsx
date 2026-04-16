import { For, Show } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import type { RewardsInfo } from "@ericsanchezok/synergy-sdk/client"

export type View = "memory" | "experience" | "skill"

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
  always: "bg-surface-interactive-base/12 text-text-interactive-base",
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
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-2">
        <span class="text-12-medium text-text-base">
          {props.count} / {props.total} selected
        </span>
        <Show when={props.count < props.total}>
          <button
            type="button"
            class="px-2 py-0.5 rounded-md text-12-medium text-text-interactive-base hover:bg-surface-interactive-base/15 transition-colors"
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
              "flex items-center gap-1 px-2.5 py-1 rounded-lg text-12-medium transition-colors": true,
              "text-text-diff-delete-base hover:bg-surface-raised-base-hover": !props.deleting,
              "text-text-weaker pointer-events-none": props.deleting,
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
          class="px-2.5 py-1 rounded-lg text-12-medium text-text-weak hover:text-text-base hover:bg-surface-raised-base-hover transition-colors"
          onClick={props.onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

export function ViewTab(props: { active: boolean; onClick: () => void; children: any }) {
  return (
    <button
      type="button"
      classList={{
        "flex-1 px-3 py-1.5 rounded-md text-12-medium text-center transition-all duration-200": true,
        "bg-surface-raised-base text-text-strong shadow-sm scale-[1.02]": props.active,
        "text-text-weak hover:text-text-base scale-100": !props.active,
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
        "shrink-0 size-4 rounded border flex items-center justify-center transition-colors": true,
        "border-text-interactive-base bg-surface-interactive-base": props.selected,
        "border-border-base bg-surface-base": !props.selected,
      }}
    >
      <Show when={props.selected}>
        <Icon name="check" size="small" class="text-text-on-interactive-base scale-75" />
      </Show>
    </div>
  )
}
