import { For, Show } from "solid-js"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import type { ConfigSetSummary } from "@ericsanchezok/synergy-sdk/client"
import { SectionLabel } from "../components/SectionLabel"

export function ConfigSetsPanel(props: {
  configSets: ConfigSetSummary[]
  selectedSetName: () => string | undefined
  activeSetName: () => string | undefined
  createSetName: () => string
  creatingSet: () => boolean
  onOpenSet: (name: string) => void
  onActivateSet: (name: string) => Promise<void>
  onDeleteSet: (name: string) => Promise<void>
  onCreateSetNameChange: (value: string) => void
  onCreateSet: () => Promise<void>
}) {
  return (
    <div class="ds-content-inner">
      <h1 class="ds-content-title">Config Sets</h1>
      <div class="ds-setting-section">
        <SectionLabel title="All Sets" />
        <p class="ds-section-hint">
          Active controls runtime behavior. Edit picks which Config Set the other tabs are currently changing.
        </p>
        <For each={props.configSets}>
          {(set) => (
            <div class="ds-config-set-row" classList={{ "ds-config-set-row-active": set.active }}>
              <div class="flex items-center gap-2 min-w-0 flex-1">
                <span class="text-13-medium text-text-base truncate">{set.name}</span>
                <Show when={set.active}>
                  <span class="ds-inline-badge">Active</span>
                </Show>
                <Show when={props.selectedSetName() === set.name && !set.active}>
                  <span class="ds-inline-badge ds-inline-badge-muted">Editing</span>
                </Show>
              </div>
              <div class="flex items-center gap-2">
                <Button type="button" variant="ghost" size="small" onClick={() => props.onOpenSet(set.name)}>
                  Open
                </Button>
                <Show when={!set.active}>
                  <Button
                    type="button"
                    variant="secondary"
                    size="small"
                    onClick={() => void props.onActivateSet(set.name)}
                  >
                    Activate
                  </Button>
                </Show>
                <Show when={!set.active}>
                  <IconButton icon="trash-2" variant="ghost" onClick={() => void props.onDeleteSet(set.name)} />
                </Show>
              </div>
            </div>
          )}
        </For>
      </div>
      <div class="ds-setting-section">
        <SectionLabel title="Create Set" />
        <p class="ds-section-hint">Create a new Config Set by copying the current active one.</p>
        <div class="flex items-center gap-3">
          <div class="flex-1 min-w-0">
            <TextField
              type="text"
              placeholder="e.g. work, writing, eval"
              value={props.createSetName()}
              onChange={props.onCreateSetNameChange}
            />
          </div>
          <Button
            type="button"
            variant="primary"
            size="small"
            disabled={props.creatingSet()}
            onClick={() => void props.onCreateSet()}
          >
            {props.creatingSet() ? "Creating..." : "Create"}
          </Button>
        </div>
      </div>
    </div>
  )
}
