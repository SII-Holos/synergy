import { useLingui } from "@lingui/solid"
import { createMemo, createSignal, onMount, Show, type Component } from "solid-js"
import { List } from "@ericsanchezok/synergy-ui/list"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { Tag } from "@ericsanchezok/synergy-ui/tag"
import {
  listModelSelectionEntries,
  listSelectableConnectedModels,
  modelRefKey,
  modelSelectionKey,
  recommendQuickSwitcherModels,
  resolveQuickSwitcherModels,
  type QuickSwitcherPreference,
} from "@/components/provider/model-catalog"
import { compareProviderIDs, type ProviderRecommendationMap } from "@/components/provider/provider-recommendation"
import { useGlobalSync } from "@/context/global-sync"
import { useLocal, type LocalModel, type ModelKey } from "@/context/local"
import { useProviders } from "@/hooks/use-providers"
import "./model-manager.css"

const freeTag = { id: "model.manager.tag.free", message: "Free" }
const latestTag = { id: "model.manager.tag.latest", message: "Latest" }
const commonLabel = { id: "model.manager.common", message: "Common models" }
const searchModelsPlaceholder = { id: "model.manager.search.placeholder", message: "Search models" }
const noConnectedLabel = { id: "model.manager.empty.connected", message: "No connected model results" }

export function sortModelGroups(profiles: ProviderRecommendationMap) {
  type Group = { category: string; items: LocalModel[] }
  return (left: Group, right: Group) => {
    const leftProvider = left.items[0]?.provider
    const rightProvider = right.items[0]?.provider
    if (!leftProvider || !rightProvider) return left.category.localeCompare(right.category)
    return compareProviderIDs(
      profiles,
      { id: leftProvider.id, name: leftProvider.name },
      { id: rightProvider.id, name: rightProvider.name },
    )
  }
}

export function ModelManagerRow(props: { model: LocalModel; compact?: boolean; providerLabel?: string }) {
  const { _ } = useLingui()
  const showFree =
    (props.model.cost?.input ?? 0) === 0 &&
    (props.model.cost?.output ?? 0) === 0 &&
    !props.model.name.toLowerCase().includes("free")

  return (
    <div class="w-full min-w-0 flex flex-col gap-y-0.5 text-left">
      <div class="model-manager-name w-full min-w-0 flex items-center gap-x-2 text-13-regular">
        <span class="model-manager-model-name min-w-0 truncate flex-1">{props.model.name}</span>
        <Show when={showFree}>
          <Tag>{_(freeTag)}</Tag>
        </Show>
        <Show when={!props.compact && props.model.latest}>
          <Tag>{_(latestTag)}</Tag>
        </Show>
      </div>
      <Show when={props.providerLabel}>
        <span
          class="model-manager-provider-name w-full truncate text-12-regular text-text-weak"
          title={props.providerLabel}
        >
          {props.providerLabel}
        </span>
      </Show>
    </div>
  )
}

export const ModelSelectionList: Component<{
  provider?: string
  class?: string
  onSelect: () => void
}> = (props) => {
  const local = useLocal()
  const globalSync = useGlobalSync()
  const providers = useProviders()
  onMount(() => {
    void providers.ensureCatalog().catch(() => {})
  })

  const [query, setQuery] = createSignal("")
  const searching = () => query().length > 0
  const entries = createMemo(() =>
    listModelSelectionEntries(local.model.all(), local.model.quickSwitcher(), local.model.recent(), props.provider),
  )
  const commonKeys = createMemo(() => new Set(entries().common.map(modelSelectionKey)))
  const models = createMemo(() => [
    ...entries().common,
    ...entries().catalog.filter((model) => !commonKeys().has(modelSelectionKey(model))),
  ])

  const { _ } = useLingui()
  const providerLabel = (provider: LocalModel["provider"]) => {
    const ambiguous =
      provider.name === _(commonLabel) ||
      providers.all().some((other) => other.id !== provider.id && other.name === provider.name)
    return ambiguous ? `${provider.name} (${provider.id})` : provider.name
  }
  return (
    <div class={`model-selection flex min-h-0 flex-1 flex-col ${props.class ?? ""}`}>
      <List<LocalModel>
        class="model-quick-switcher flex-1 min-h-0 [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:min-h-0"
        search={{ placeholder: _(searchModelsPlaceholder), autofocus: true, onChange: setQuery }}
        emptyMessage={_(noConnectedLabel)}
        key={modelSelectionKey}
        selectOnTab={false}
        items={models()}
        current={local.model.current()}
        filterKeys={["provider.name", "provider.id", "name", "id"]}
        groupBy={(model) =>
          searching()
            ? ""
            : commonKeys().has(modelSelectionKey(model))
              ? "common"
              : JSON.stringify(["provider", model.provider.id])
        }
        groupLabel={(group) => {
          if (group.category === "common") return _(commonLabel)
          const provider = group.items[0]?.provider
          return provider ? providerLabel(provider) : group.category
        }}
        sortGroupsBy={(left, right) =>
          Number(right.category === "common") - Number(left.category === "common") ||
          sortModelGroups(globalSync.data.provider.profiles)(left, right)
        }
        onSelect={(model) => {
          if (!model) return
          local.model.set({ modelID: model.id, providerID: model.provider.id }, { recent: true })
          props.onSelect()
        }}
      >
        {(model) => (
          <ModelManagerRow
            model={model}
            compact
            providerLabel={
              searching() || commonKeys().has(modelSelectionKey(model)) ? providerLabel(model.provider) : undefined
            }
          />
        )}
      </List>
    </div>
  )
}

function optionalLocal() {
  try {
    return useLocal()
  } catch {
    return undefined
  }
}

export type QuickSwitcherModelPreference = QuickSwitcherPreference

function nextQuickSwitcherPreferences(
  preferences: QuickSwitcherModelPreference[],
  recommended: Set<string>,
  model: ModelKey,
  included: boolean,
): QuickSwitcherModelPreference[] {
  const recommendedByDefault = recommended.has(modelRefKey(model))
  const nextState: "add" | "remove" | undefined =
    included === recommendedByDefault ? undefined : included ? "add" : "remove"
  const index = preferences.findIndex((item) => item.providerID === model.providerID && item.modelID === model.modelID)

  if (!nextState) {
    if (index < 0) return preferences
    return preferences.filter((_, itemIndex) => itemIndex !== index)
  }

  if (index >= 0) {
    const next = [...preferences]
    next[index] = { ...preferences[index], state: nextState }
    return next
  }

  return [...preferences, { ...model, state: nextState }]
}

export const ConnectedModelManager: Component<{
  provider?: string
  class?: string
  searchAutofocus?: boolean
  selectable?: boolean
  quickSwitcher?: QuickSwitcherModelPreference[]
  onQuickSwitcherChange?: (preferences: QuickSwitcherModelPreference[]) => void
  onSelect?: () => void
}> = (props) => {
  const globalSync = useGlobalSync()
  const providers = useProviders()
  onMount(() => {
    void providers.ensureCatalog().catch(() => {})
  })

  const models = createMemo(() =>
    listSelectableConnectedModels(
      providers.all(),
      providers.connected().map((provider) => provider.id),
      props.provider,
    ).sort((a, b) => a.name.localeCompare(b.name)),
  )

  const local = optionalLocal()
  const selectable = () => props.selectable !== false
  const currentModel = () => (props.selectable === false ? undefined : local?.model.current())
  const recommended = createMemo(() => recommendQuickSwitcherModels(models(), providers.default()))
  const recommendedSet = createMemo(() => new Set(recommended().map(modelRefKey)))
  const quickSwitcherSet = createMemo(
    () =>
      new Set(
        resolveQuickSwitcherModels(
          recommended(),
          props.quickSwitcher ?? local?.model.quickSwitcherPreferences() ?? [],
        ).map(modelRefKey),
      ),
  )
  const inQuickSwitcher = (model: ModelKey) => quickSwitcherSet().has(modelRefKey(model))
  const setQuickSwitcher = (model: ModelKey, included: boolean) => {
    const current: QuickSwitcherModelPreference[] = props.quickSwitcher ?? local?.model.quickSwitcherPreferences() ?? []
    const next = nextQuickSwitcherPreferences(current, recommendedSet(), model, included)
    if (props.onQuickSwitcherChange) {
      props.onQuickSwitcherChange(next)
      return
    }
    return
  }
  const selectModel = (model: ModelKey) => {
    local?.model.set(model, { recent: true })
  }

  const { _ } = useLingui()
  return (
    <List
      class={props.class}
      search={{ placeholder: _(searchModelsPlaceholder), autofocus: props.searchAutofocus }}
      emptyMessage={_(noConnectedLabel)}
      key={modelSelectionKey}
      items={models()}
      current={currentModel()}
      interactive={selectable()}
      filterKeys={["provider.name", "name", "id"]}
      groupBy={(x) => x.provider.name}
      sortGroupsBy={sortModelGroups(globalSync.data.provider.profiles)}
      onSelect={
        selectable()
          ? (x) => {
              if (!x) return
              selectModel({ modelID: x.id, providerID: x.provider.id })
              props.onSelect?.()
            }
          : undefined
      }
    >
      {(model) => (
        <div class="model-manager-row w-full min-w-0 flex items-center justify-between gap-x-3">
          <ModelManagerRow model={model} />
          <div class="model-manager-actions flex items-center gap-x-3 shrink-0" onClick={(e) => e.stopPropagation()}>
            <Switch
              aria-label={_({
                id: "settings.models.common.toggle",
                message: "Include {model} in common models",
                values: { model: model.name },
              })}
              checked={inQuickSwitcher({ modelID: model.id, providerID: model.provider.id })}
              onChange={(checked) => {
                setQuickSwitcher({ modelID: model.id, providerID: model.provider.id }, checked)
              }}
            >
              <span class="model-manager-quick-label text-12-regular text-text-weak">{_(commonLabel)}</span>
            </Switch>
          </div>
        </div>
      )}
    </List>
  )
}
