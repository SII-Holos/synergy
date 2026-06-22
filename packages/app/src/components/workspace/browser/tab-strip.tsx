import { Show } from "solid-js"
import type { BrowserTab } from "./browser-store"

export type TabStripProps = {
  tabs: BrowserTab[]
  activeTabId: string | null
  onSwitch: (id: string) => void
  onClose: (id: string) => void
  onAddTab: () => void
}

export function TabStrip(props: TabStripProps) {
  return (
    <div class="flex items-center h-9 shrink-0 border-b border-border-weak-base bg-surface-raised-base overflow-x-auto">
      {props.tabs.map((tab) => (
        <TabItem
          tab={tab}
          isActive={tab.id === props.activeTabId}
          onSwitch={() => props.onSwitch(tab.id)}
          onClose={() => props.onClose(tab.id)}
        />
      ))}
      <button
        type="button"
        class="flex items-center justify-center size-7 shrink-0 ml-0.5 rounded text-icon-weak hover:text-icon-base hover:bg-surface-raised-base-hover transition-colors"
        onClick={props.onAddTab}
        aria-label="New tab"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M7 3V11M3 7H11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        </svg>
      </button>
    </div>
  )
}

type TabItemProps = {
  tab: BrowserTab
  isActive: boolean
  onSwitch: () => void
  onClose: () => void
}

function TabItem(props: TabItemProps) {
  return (
    <button
      type="button"
      class="group flex items-center gap-1.5 h-full px-3 text-12 shrink-0 transition-colors border-r border-border-weak-base/60"
      classList={{
        "bg-surface-inset-base text-text-strong": props.isActive,
        "text-text-weak hover:text-text-base hover:bg-surface-raised-base-hover": !props.isActive,
      }}
      onClick={props.onSwitch}
    >
      <Show when={props.tab.isLoading} fallback={<span class="w-2" />}>
        <span class="block size-2 rounded-full bg-surface-interactive-base animate-pulse" />
      </Show>
      <span class="max-w-[120px] truncate">{props.tab.title || "Untitled"}</span>
      <span
        class="flex items-center justify-center size-4 rounded text-icon-weak opacity-0 group-hover:opacity-100 hover:text-icon-base hover:bg-surface-raised-stronger-non-alpha transition-opacity"
        classList={{ "opacity-100": props.isActive }}
        onClick={(e) => {
          e.stopPropagation()
          props.onClose()
        }}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M3 3L9 9M9 3L3 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        </svg>
      </span>
    </button>
  )
}
