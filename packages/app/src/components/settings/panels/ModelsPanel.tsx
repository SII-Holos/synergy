import { Button } from "@ericsanchezok/synergy-ui/button"
import type { ModelRoleSummary } from "@ericsanchezok/synergy-sdk/client"
import { For, Show } from "solid-js"
import { ConnectedModelManager } from "@/components/model-manager"
import { groupByProvider } from "../types"
import { ModelRoleRow } from "../components/ModelRoleRow"
import type { ModelKey, ModelsStore, ProviderModel } from "../types"

export function ModelsPanel(props: {
  models: ModelsStore
  providerModels: () => ProviderModel[]
  modelRoleSummaries: () => ModelRoleSummary[]
  onModelChange: (key: ModelKey, value: string) => void
  onConnectProvider: () => void
}) {
  const providerGroups = () => groupByProvider(props.providerModels())

  return (
    <div class="ds-content-inner">
      <div class="ds-content-header">
        <div>
          <h1 class="ds-content-title">Models</h1>
          <p class="ds-section-hint">
            Choose specialist role models and decide which connected models appear in quick switcher.
          </p>
        </div>
      </div>

      <section class="settings-model-section">
        <div class="settings-model-section-heading">
          <div>
            <h2 class="settings-model-section-title">Model roles</h2>
            <p class="settings-model-section-description">
              Leave a role on fallback to inherit the next available model.
            </p>
          </div>
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
      </section>

      <section class="settings-model-section settings-connected-models-section">
        <div class="settings-model-section-heading">
          <div>
            <h2 class="settings-model-section-title">Quick switcher models</h2>
            <p class="settings-model-section-description">
              Pick the connected models that appear in model switchers and command shortcuts.
            </p>
          </div>
          <Button type="button" variant="ghost" size="small" icon="plus" onClick={props.onConnectProvider}>
            Connect provider
          </Button>
        </div>

        <ConnectedModelManager class="settings-connected-model-list" searchAutofocus={false} selectable={false} />
      </section>
    </div>
  )
}
