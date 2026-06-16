import { Button } from "@ericsanchezok/synergy-ui/button"
import { For, Show } from "solid-js"
import { DialogSelectModel } from "@/components/dialog/dialog-select-model"
import type { ProviderGroup } from "../types"
import { MODEL_ROLES } from "../types"
import { ModelsStore } from "../types"
import { groupByProvider } from "../types"
import { ProviderModel } from "../types"
import { ModelRoleRow } from "../components/ModelRoleRow"

export function ModelsPanel(props: {
  models: ModelsStore
  providerModels: () => ProviderModel[]
  onModelChange: (key: keyof ModelsStore, value: string) => void
  onManageModels: () => void
}) {
  const providerGroups = () => groupByProvider(props.providerModels())

  return (
    <div class="ds-content-inner">
      <h1 class="ds-content-title">Models</h1>
      <p class="ds-section-hint">
        Assign specific models for different task types. Leave empty to use the default model.
      </p>
      <Button type="button" variant="ghost" size="small" onClick={props.onManageModels}>
        Manage models
      </Button>
      <Show
        when={props.providerModels().length > 0}
        fallback={
          <div class="ds-empty-state">
            <span>No connected models found</span>
          </div>
        }
      >
        <For each={MODEL_ROLES}>
          {(role) => (
            <ModelRoleRow
              label={role.label}
              description={role.description}
              value={props.models[role.key]}
              providers={providerGroups()}
              onChange={(value: string) => props.onModelChange(role.key, value)}
            />
          )}
        </For>
      </Show>
    </div>
  )
}
