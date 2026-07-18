import { useLingui } from "@lingui/solid"
import { createMemo, Show, type Component } from "solid-js"
import { List } from "@ericsanchezok/synergy-ui/list"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { Tag } from "@ericsanchezok/synergy-ui/tag"
import { compareProviderIDs, type ProviderRecommendationMap } from "@/components/provider/provider-recommendation"
import { useGlobalSync } from "@/context/global-sync"
import { useLocal, type LocalModel, type ModelKey } from "@/context/local"
import { useProviders } from "@/hooks/use-providers"

const freeTag = { id: "model.manager.tag.free", message: "Free" }
const latestTag = { id: "model.manager.tag.latest", message: "Latest" }
const quickLabel = { id: "model.manager.quick", message: "Quick" }
const searchModelsPlaceholder = { id: "model.manager.search.placeholder", message: "Search models" }
const noQuickSwitchLabel = { id: "model.manager.empty.quickSwitch", message: "No quick-switch models" }
const noConnectedLabel = { id: "model.manager.empty.connected", message: "No connected model results" }
export function sortModelGroups(profiles: ProviderRecommendationMap) {
  return (a: { category: string; items: LocalModel[] }, b: { category: string; items: LocalModel[] }) => {
    if (a.category === "Recent" && b.category !== "Recent") return -1
    if (b.category === "Recent" && a.category !== "Recent") return 1

    const aProvider = a.items[0]?.provider
    const bProvider = b.items[0]?.provider
    if (!aProvider || !bProvider) return a.category.localeCompare(b.category)
    return compareProviderIDs(
      profiles,
      { id: aProvider.id, name: aProvider.name },
      { id: bProvider.id, name: bProvider.name },
    )
  }
}

export function ModelManagerRow(props: { model: LocalModel; compact?: boolean }) {
  const { _ } = useLingui()
  const showFree =
    (props.model.cost?.input ?? 0) === 0 &&
    (props.model.cost?.output ?? 0) === 0 &&
    !props.model.name.toLowerCase().includes("free")

  return (
    <div class="model-manager-name w-full min-w-0 flex items-center gap-x-2 text-left text-13-regular">
      <span class="model-manager-model-name min-w-0 truncate flex-1">{props.model.name}</span>
      <Show when={showFree}>
        <Tag>{_(freeTag)}</Tag>
      </Show>
      <Show when={!props.compact && props.model.latest}>
        <Tag>{_(latestTag)}</Tag>
      </Show>
    </div>
  )
}

type QuickSwitcherEntry = LocalModel & {
  group: string
  listKey: string
}

export const QuickSwitcherList: Component<{
  provider?: string
  class?: string
  onSelect: () => void
}> = (props) => {
  const local = useLocal()
  const globalSync = useGlobalSync()

  const models = createMemo<QuickSwitcherEntry[]>(() => {
    const filtered = local.model
      .quickSwitcher()
      .filter((model) => (props.provider ? model.provider.id === props.provider : true))
      .sort((a, b) => a.name.localeCompare(b.name))

    const entries = filtered.map((model) => ({
      ...model,
      group: model.provider.name,
      listKey: `${model.provider.id}:${model.id}`,
    }))

    const recentEntries = local.model
      .recent()
      .filter((model) => (props.provider ? model.provider.id === props.provider : true))
      .filter((model) => filtered.some((item) => item.provider.id === model.provider.id && item.id === model.id))
      .map((model) => ({
        ...model,
        group: "Recent",
        listKey: `recent:${model.provider.id}:${model.id}`,
      }))

    return [...recentEntries, ...entries]
  })

  const current = createMemo<QuickSwitcherEntry | undefined>(() => {
    const selected = local.model.current()
    if (!selected) return undefined
    return models().find((model) => model.provider.id === selected.provider.id && model.id === selected.id)
  })

  const { _ } = useLingui()
  return (
    <List<QuickSwitcherEntry>
      class={`flex-1 min-h-0 [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:min-h-0 ${props.class ?? ""}`}
      search={{ placeholder: _(searchModelsPlaceholder), autofocus: true }}
      emptyMessage={_(noQuickSwitchLabel)}
      key={(x) => x.listKey}
      items={models}
      current={current()}
      filterKeys={["provider.name", "name", "id"]}
      groupBy={(x) => x.group}
      sortGroupsBy={sortModelGroups(globalSync.data.provider.profiles)}
      onSelect={(x) => {
        if (!x) return
        local.model.set({ modelID: x.id, providerID: x.provider.id }, { recent: true })
        props.onSelect?.()
      }}
    >
      {(model) => <ModelManagerRow model={model} compact />}
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

function uniqueModelKeys(models: ModelKey[]) {
  const seen = new Set<string>()
  return models.filter((model) => {
    const key = modelKey(model)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function newest(models: LocalModel[]) {
  return [...models].sort((a, b) => String(b.release_date ?? "").localeCompare(String(a.release_date ?? "")))[0]
}

export type QuickSwitcherModelPreference = ModelKey & { state: "add" | "remove" }

function quickSwitcherPreferenceMap(preferences: QuickSwitcherModelPreference[]) {
  const map = new Map<string, "add" | "remove">()
  for (const item of preferences) {
    map.set(modelKey(item), item.state)
  }
  return map
}

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

  const models = createMemo(() =>
    providers
      .all()
      .flatMap((p) =>
        Object.values(p.models).map((m) => ({
          ...m,
          provider: p,
          name: m.name.replace("(latest)", "").trim(),
          latest: m.name.includes("(latest)"),
        })),
      )
      .filter((model) =>
        providers
          .connected()
          .map((p) => p.id)
          .includes(model.provider.id),
      )
      .filter((model) => (props.provider ? model.provider.id === props.provider : true))
      .sort((a, b) => a.name.localeCompare(b.name)),
  )

  const local = optionalLocal()
  const selectable = () => props.selectable !== false
  const currentModel = () => (props.selectable === false ? undefined : local?.model.current())
  const recommended = createMemo(() => {
    const result: ModelKey[] = []
    const push = (model: LocalModel | undefined) => {
      if (!model) return
      result.push({ providerID: model.provider.id, modelID: model.id })
    }

    const providerIDs = [...new Set(models().map((model) => model.provider.id))]
    for (const providerID of providerIDs) {
      const providerModels = models().filter((model) => model.provider.id === providerID)
      if (providerModels.length === 0) continue

      const defaultModelID = providers.default()[providerID]
      push(providerModels.find((model) => model.id === defaultModelID))
      push(newest(providerModels.filter((model) => model.capabilities.reasoning)))
      push(newest(providerModels.filter((model) => (model.cost?.input ?? 0) === 0 && (model.cost?.output ?? 0) === 0)))
      push(
        newest(
          providerModels.filter(
            (model) => model.capabilities.input.image || model.capabilities.input.pdf || model.capabilities.input.video,
          ),
        ),
      )
    }

    return uniqueModelKeys(result)
  })
  const recommendedSet = createMemo(() => new Set(recommended().map(modelKey)))
  const preferenceMap = createMemo(() =>
    quickSwitcherPreferenceMap(props.quickSwitcher ?? local?.model.quickSwitcherPreferences() ?? []),
  )
  const inQuickSwitcher = (model: ModelKey) => {
    const preference = preferenceMap().get(modelKey(model))
    if (preference === "remove") return false
    if (preference === "add") return true
    return recommendedSet().has(modelKey(model))
  }
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
      items={models}
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
