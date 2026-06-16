import { For, Show } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import type { NavGroup } from "../types"
import { NAV_GROUPS } from "../types"

export function SettingsNav(props: { activeTab: () => string; onSelect: (id: string) => void }) {
  return (
    <nav class="ds-settings-nav">
      <For each={NAV_GROUPS}>
        {(group) => (
          <div class="ds-nav-group">
            <div class="ds-nav-group-header">
              <Icon name={group.icon} size="small" />
              <span>{group.label}</span>
            </div>
            <For each={group.items}>
              {(item) => (
                <button
                  type="button"
                  class="ds-nav-item"
                  classList={{ "ds-nav-item-active": props.activeTab() === item.id }}
                  onClick={() => props.onSelect(item.id)}
                >
                  <Icon name={item.icon} size="small" />
                  <span>{item.label}</span>
                </button>
              )}
            </For>
          </div>
        )}
      </For>
    </nav>
  )
}
