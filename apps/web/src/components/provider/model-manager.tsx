import { useLingui } from "@lingui/solid"
import { createMemo, onMount, Show, type Component } from "solid-js"
import { List } from "@ericsanchezok/synergy-ui/list"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { Tag } from "@ericsanchezok/synergy-ui/tag"
import {
  listModelSelectionEntries,
  listSelectableConnectedModels,
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
const quickLabel = { id: "model.manager.quick", message: "Quick switch" }
const recentLabel = { id: "model.manager.recent", message: "Recent" }
const searchModelsPlaceholder = { id: "model.manager.search.placeholder", message: "Search models" }
const noConnectedLabel = { id: "model.manager.empty.connected", message: "No connected model results" }
type ModelSelectionEntry = ReturnType<typeof listModelSelectionEntries<LocalModel>>[number]

export function sortModelGroups(profiles: ProviderRecommendationMap) {
  type Group = { category: string; items: (LocalModel & { section?: ModelSelectionEntry["section"] })[] }
  return (left: Group, right: Group) => {
    const priority = (group: Group) => {
      const section = group.items[0]?.section
      return section === "recent" ? 0 : section === "quick" ? 1 : 2
    }
    const sectionOrder = priority(left) - priority(right)
    if (sectionOrder) return sectionOrder

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
    <div class="model-manager-name w-full min-w-0 flex items-center gap-x-2 text-left text-13-regular">
      <span class="model-manager-model-name min-w-0 truncate flex-1">{props.model.name}</span>
      <Show when={props.providerLabel}>
        <span class="min-w-0 max-w-24 truncate text-12-regular text-text-weak">{props.providerLabel}</span>
      </Show>
      <Show when={showFree}>
        <Tag>{_(freeTag)}</Tag>
      </Show>
      <Show when={!props.compact && props.model.latest}>
        <Tag>{_(latestTag)}</Tag>
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

  const models = createMemo<ModelSelectionEntry[]>(() =>
    listModelSelectionEntries(local.model.all(), local.model.quickSwitcher(), local.model.recent(), props.provider),
  )

  const current = createMemo<ModelSelectionEntry | undefined>(() => {
    const selected = local.model.current()
    if (!selected) return undefined
    return models().find((model) => model.provider.id === selected.provider.id && model.id === selected.id)
  })

  const { _ } = useLingui()
  const providerLabel = (provider: LocalModel["provider"]) => {
    const ambiguous =
      provider.name === _(recentLabel) ||
      provider.name === _(quickLabel) ||
      providers.all().some((other) => other.id !== provider.id && other.name === provider.name)
    return ambiguous ? `${provider.name} (${provider.id})` : provider.name
  }
  return (
    <List<ModelSelectionEntry>
      class={`model-quick-switcher flex-1 min-h-0 [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:min-h-0 ${props.class ?? ""}`}
      search={{ placeholder: _(searchModelsPlaceholder), autofocus: true }}
      emptyMessage={_(noConnectedLabel)}
      key={(x) => x.listKey}
      selectionKey={(model) => JSON.stringify([model.provider.id, model.id])}
      items={models()}
      current={current()}
      filterKeys={["provider.name", "name", "id"]}
      groupBy={(model) =>
        model.section === "provider" ? JSON.stringify(["provider", model.provider.id]) : model.section
      }
      groupLabel={(group) => {
        if (group.category === "recent") return _(recentLabel)
        if (group.category === "quick") return _(quickLabel)
        const provider = group.items[0]?.provider
        return provider ? providerLabel(provider) : group.category
      }}
      sortGroupsBy={sortModelGroups(globalSync.data.provider.profiles)}
      onSelect={(x) => {
        if (!x) return
        local.model.set({ modelID: x.id, providerID: x.provider.id }, { recent: true })
        props.onSelect?.()
      }}
    >
      {(model) => (
        <ModelManagerRow
          model={model}
          compact
          providerLabel={model.section !== "provider" ? providerLabel(model.provider) : undefined}
        />
      )}
    </List>
  )
}

function optionalLocal() {
  try {
    return useLocal()
  } catch {
    return undefined
  }
}

function modelKey(model: ModelKey) {
  return `${model.providerID}:${model.modelID}`
}

export type QuickSwitcherModelPreference = QuickSwitcherPreference

function nextQuickSwitcherPreferences(
  preferences: QuickSwitcherModelPreference[],
  recommended: Set<string>,
  model: ModelKey,
  included: boolean,
): QuickSwitcherModelPreference[] {
  const recommendedByDefault = recommended.has(modelKey(model))
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
  const recommendedSet = createMemo(() => new Set(recommended().map(modelKey)))
  const quickSwitcherSet = createMemo(
    () =>
      new Set(
        resolveQuickSwitcherModels(
          recommended(),
          props.quickSwitcher ?? local?.model.quickSwitcherPreferences() ?? [],
        ).map(modelKey),
      ),
  )
  const inQuickSwitcher = (model: ModelKey) => quickSwitcherSet().has(modelKey(model))
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
      key={(x) => `${x.provider.id}:${x.id}`}
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
                id: "settings.models.quickSwitcher.toggle",
                message: "Include {model} in quick switcher",
                values: { model: model.name },
              })}
              checked={inQuickSwitcher({ modelID: model.id, providerID: model.provider.id })}
              onChange={(checked) => {
                setQuickSwitcher({ modelID: model.id, providerID: model.provider.id }, checked)
              }}
            >
              <span class="model-manager-quick-label text-12-regular text-text-weak">{_(quickLabel)}</span>
            </Switch>
          </div>
        </div>
      )}
    </List>
  )
}
