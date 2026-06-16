import { For, Show } from "solid-js"
import { produce } from "solid-js/store"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
import type { McpEntry } from "../types"
import { emptyMcp } from "../types"
import { McpCard } from "../components/McpCard"

export function McpPanel(props: {
  entries: McpEntry[]
  onAdd: () => void
  onChange: (index: number, field: string, value: string | boolean) => void
  onRemove: (index: number) => void
}) {
  return (
    <div class="ds-content-inner">
      <div class="ds-content-header">
        <div>
          <h1 class="ds-content-title">MCP Servers</h1>
          <p class="ds-section-hint">Configure local (stdio) or remote (HTTP/SSE) servers.</p>
        </div>
        <IconButton icon="plus" variant="ghost" onClick={props.onAdd} />
      </div>
      <For each={props.entries}>
        {(entry, index) => (
          <McpCard
            entry={entry}
            onChange={(field, value) => props.onChange(index(), field, value)}
            onRemove={() => props.onRemove(index())}
          />
        )}
      </For>
      <Show when={props.entries.length === 0}>
        <div class="ds-empty-state">
          <Icon name="server" size="normal" class="text-text-weaker" />
          <span>No MCP servers configured</span>
          <span class="text-text-weaker">Click + to add one</span>
        </div>
      </Show>
    </div>
  )
}
