import { Button } from "@ericsanchezok/synergy-ui/button"
import type { ModelRoleSummary } from "@ericsanchezok/synergy-sdk/client"
import { For, Show } from "solid-js"
import { groupByProvider } from "../types"
import { ModelRoleRow } from "../components/ModelRoleRow"
import type { ModelKey, ModelsStore, ProviderModel } from "../types"

export function ModelsPanel(props: {
  models: ModelsStore
  providerModels: () => ProviderModel[]
  modelRoleSummaries: () => ModelRoleSummary[]
  onModelChange: (key: ModelKey, value: string) => void
  onManageModels: () => void
}) {
  const providerGroups = () => groupByProvider(props.providerModels())

  return (
    <div class="ds-content-inner">
      <div class="ds-content-header">
        <div>
          <h1 class="ds-content-title">Models</h1>
          <p class="ds-section-hint">
            Choose specialist models for agent roles. Leave a role on fallback to inherit the next available model.
          </p>
        </div>
        <Button type="button" variant="ghost" size="small" onClick={props.onManageModels}>
          Manage models
        </Button>
      </div>

      <Show
        when={props.modelRoleSummaries().length > 0}
        fallback={
          <div class="ds-empty-state">
            <span>Model roles are loading</span>
          </div>
        }
      >
        <div class="settings-model-list">
          <For each={props.modelRoleSummaries()}>
            {(summary) => (
              <ModelRoleRow
                summary={summary}
                value={props.models[summary.field as ModelKey]}
                providers={providerGroups()}
                onChange={props.onModelChange}
              />
            )}
          </For>
        </div>
        <Show when={props.providerModels().length === 0}>
          <div class="ds-empty-state settings-model-empty">
            <span>Connect a provider to choose concrete models. Roles can still use fallback.</span>
          </div>
        </Show>
      </Show>
    </div>
  )
}
