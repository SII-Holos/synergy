import { For, createMemo } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon, type SemanticIconTokenName } from "@ericsanchezok/synergy-ui/semantic-icon"
import type { PermissionItem } from "./schema"

interface PermissionDiffListProps {
  items: PermissionItem[]
  mode: "added" | "removed" | "unchanged"
}

type CategoryLabel = string

const CATEGORY_ORDER: readonly string[] = ["tools", "runtime", "network", "data", "ui"]

const CATEGORY_LABELS: Record<string, CategoryLabel> = {
  tools: "Tools",
  runtime: "Runtime",
  network: "Network",
  data: "Data",
  ui: "UI",
  files: "Data",
  hooks: "Runtime",
}

const MODE_CONFIG = {
  added: {
    icon: "action.add" as const,
    prefix: "+",
    iconClass: "text-icon-success-base",
    containerClass: "",
  },
  removed: {
    icon: "action.remove" as const,
    prefix: "\u2212",
    iconClass: "text-icon-weak opacity-50",
    containerClass: "",
  },
  unchanged: {
    icon: "state.empty" as const,
    prefix: "\u003D",
    iconClass: "text-icon-weak",
    containerClass: "",
  },
} as const

function categoryIcon(category: string): SemanticIconTokenName {
  switch (category) {
    case "tools":
      return "plugins.permission.tools"
    case "runtime":
      return "plugins.permission.runtime"
    case "network":
      return "plugins.permission.network"
    case "data":
      return "plugins.permission.data"
    case "ui":
      return "plugins.permission.ui"
    case "files":
      return "plugins.permission.filesystem"
    case "hooks":
      return "plugins.permission.hooks"
    default:
      return "state.empty"
  }
}

export function PermissionDiffList(props: PermissionDiffListProps) {
  const config = MODE_CONFIG[props.mode]

  const grouped = createMemo(() => {
    const map = new Map<string, PermissionItem[]>()
    for (const item of props.items) {
      const cat = item.category
      if (!map.has(cat)) map.set(cat, [])
      map.get(cat)!.push(item)
    }
    const entries: { category: string; label: string; items: PermissionItem[] }[] = []
    for (const cat of CATEGORY_ORDER) {
      const items = map.get(cat)
      if (items && items.length > 0) {
        entries.push({ category: cat, label: CATEGORY_LABELS[cat] ?? cat, items })
      }
    }
    // Include any remaining categories not in the ordered list
    for (const [cat, items] of map) {
      if (!CATEGORY_ORDER.includes(cat)) {
        entries.push({ category: cat, label: CATEGORY_LABELS[cat] ?? cat, items })
      }
    }
    return entries
  })

  const iconCircleClass = (mode: string) =>
    `inline-flex size-5 shrink-0 items-center justify-center rounded-full mt-px ${
      mode === "added" ? "bg-surface-success-soft" : "bg-surface-muted"
    }`

  const titleClassForMode = (mode: string) =>
    `text-13-medium truncate ${
      mode === "removed"
        ? "text-text-weak opacity-50 line-through"
        : mode === "added"
          ? "text-text-success"
          : "text-text-base"
    }`

  const descClassForMode = (mode: string) =>
    `text-12-regular mt-0.5 line-clamp-2 ${mode === "removed" ? "text-text-weak opacity-40" : "text-text-weak"}`

  return (
    <div class="permission-diff-list flex flex-col gap-3">
      {grouped().length === 0 ? (
        <p class="text-13-regular text-text-weak">No permissions in this category.</p>
      ) : (
        <For each={grouped()}>
          {(group) => (
            <div class="permission-diff-group">
              <div class="flex items-center gap-2 mb-1.5">
                <Icon
                  name={getSemanticIcon(categoryIcon(group.category))}
                  size="small"
                  class="shrink-0 text-icon-weak"
                />
                <p class="text-12-medium text-text-weak uppercase tracking-wider">
                  {group.label}
                  <span class="ml-1 normal-case tracking-normal text-text-weaker">({group.items.length})</span>
                </p>
              </div>
              <ul class="flex flex-col gap-1">
                <For each={group.items}>
                  {(item) => (
                    <li class="flex items-start gap-2 rounded-md bg-surface-base px-3 py-2">
                      <span class={iconCircleClass(props.mode)}>
                        <Icon name={getSemanticIcon(config.icon)} size="small" class={config.iconClass} />
                      </span>
                      <div class="min-w-0 flex-1">
                        <p class={titleClassForMode(props.mode)}>{item.title}</p>
                        <p class={descClassForMode(props.mode)}>{item.description}</p>
                      </div>
                    </li>
                  )}
                </For>
              </ul>
            </div>
          )}
        </For>
      )}
    </div>
  )
}
