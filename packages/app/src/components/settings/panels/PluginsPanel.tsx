import { For, Show } from "solid-js"
import { produce } from "solid-js/store"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
import type { PluginEntry } from "../types"

export function PluginsPanel(props: {
  entries: PluginEntry[]
  onAdd: () => void
  onChange: (index: number, value: string) => void
  onRemove: (index: number) => void
}) {
  return (
    <div class="ds-content-inner">
      <div class="ds-content-header">
        <div>
          <h1 class="ds-content-title">Plugins</h1>
          <p class="ds-section-hint">Extend with custom tools, hooks, and integrations.</p>
        </div>
        <IconButton icon="plus" variant="ghost" onClick={props.onAdd} />
      </div>
      <For each={props.entries}>
        {(entry, index) => (
          <div class="flex items-center gap-2">
            <div class="flex-1">
              <TextField
                type="text"
                placeholder="e.g. @scope/plugin or file:///path/to/plugin.ts"
                value={entry.value}
                onChange={(value) => props.onChange(index(), value)}
              />
            </div>
            <IconButton icon="x" variant="ghost" onClick={() => props.onRemove(index())} />
          </div>
        )}
      </For>
      <Show when={props.entries.length === 0}>
        <div class="ds-empty-state">
          <Icon name="zap" size="normal" class="text-text-weaker" />
          <span>No plugins configured</span>
          <span class="text-text-weaker">Click + to add one</span>
        </div>
      </Show>
    </div>
  )
}
