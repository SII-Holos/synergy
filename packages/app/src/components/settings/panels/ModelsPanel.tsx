import { Button } from "@ericsanchezok/synergy-ui/button"
import type { ModelRoleSummary } from "@ericsanchezok/synergy-sdk/client"
import { For, Show } from "solid-js"
import { ConnectedModelManager } from "@/components/model-manager"
import { groupByProvider } from "../types"
import { ModelRoleRow } from "../components/ModelRoleRow"
import type { ModelKey, ModelsStore, ProviderModel } from "../types"
import { SettingsPage, SettingsSection } from "../components/SettingsPrimitives"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"

export function ModelsPanel(props: {
  models: ModelsStore
  savedModels: ModelsStore
  providerModels: () => ProviderModel[]
  modelRoleSummaries: () => ModelRoleSummary[]
  roleVariant: Record<string, string>
  popoverLayer?: HTMLElement
  onModelChange: (key: ModelKey, value: string) => void
  onVariantChange: (roleId: string, variant: string) => void
  onQuickSwitcherChange: (preferences: ModelsStore["quick_switcher"]) => void
  onConnectProvider: () => void
}) {
  const providerGroups = () => groupByProvider(props.providerModels())

  function getAvailableVariants(
    resolvedModel?: { providerID: string; modelID: string },
    draftValue?: string,
  ): string[] {
    if (draftValue) {
      const idx = draftValue.indexOf("/")
      if (idx !== -1) {
        const providerID = draftValue.slice(0, idx)
        const modelID = draftValue.slice(idx + 1)
        for (const group of providerGroups()) {
          if (group.providerId !== providerID) continue
          const model = group.models.find((m) => m.id === modelID)
          if (model) return model.variantKeys
        }
      }
      return []
    }
    if (!resolvedModel) return []
    for (const group of providerGroups()) {
      if (group.providerId !== resolvedModel.providerID) continue
      const model = group.models.find((m) => m.id === resolvedModel.modelID)
      if (model) return model.variantKeys
    }
    return []
  }

  return (
    <SettingsPage
      title="Models"
      description="Choose specialist role models and decide which connected models appear in quick switcher."
      actions={
        <Button
          type="button"
          variant="ghost"
          size="small"
          icon={getSemanticIcon("action.add")}
          onClick={props.onConnectProvider}
        >
          Connect provider
        </Button>
      }
    >
      <SettingsSection title="Model roles" description="Leave a role on fallback to inherit the next available model.">
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
                  draftModels={props.models}
                  savedModels={props.savedModels}
                  providers={providerGroups()}
                  roleVariant={props.roleVariant[summary.id] ?? ""}
                  availableVariants={getAvailableVariants(
                    summary.resolvedModel,
                    props.models[summary.field as ModelKey] || undefined,
                  )}
                  popoverLayer={props.popoverLayer}
                  onChange={props.onModelChange}
                  onVariantChange={(variant) => props.onVariantChange(summary.id, variant)}
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
      </SettingsSection>

      <SettingsSection
        title="Quick switcher models"
        description="Pick the connected models that appear in model switchers and command shortcuts."
      >
        <ConnectedModelManager
          class="settings-connected-model-list"
          searchAutofocus={false}
          selectable={false}
          quickSwitcher={props.models.quick_switcher}
          onQuickSwitcherChange={props.onQuickSwitcherChange}
        />
      </SettingsSection>
    </SettingsPage>
  )
}
