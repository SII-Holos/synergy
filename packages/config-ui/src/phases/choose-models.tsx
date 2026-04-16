import { For, Show, createMemo, createSignal, type Component } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { InlineAlert, PageIntro, SectionCard, StatusPill, Tag } from "../components"
import { useDictionary } from "../locale"
import { configStore, resetCoreValidation, setConfigStore, type ModelInfo } from "../store"

type ModelCategory = "default" | "vision"

type ModelSelectionMeta = {
  title: string
  description: string
  storeKey: "selectedModel" | "selectedVisionModel"
  filter: (model: ModelInfo) => boolean
}

const ModelSelectionCard: Component<{ category: ModelCategory }> = (props) => {
  const { t } = useDictionary()
  const [search, setSearch] = createSignal("")
  const [collapsed, setCollapsed] = createSignal<Set<string>>(new Set())

  const meta = createMemo<ModelSelectionMeta>(() =>
    props.category === "vision"
      ? {
          title: t("visionModelTitle"),
          description: t("visionModelDescription"),
          storeKey: "selectedVisionModel" as const,
          filter: (model: ModelInfo): boolean => model.multimodal,
        }
      : {
          title: t("defaultModelTitle"),
          description: t("defaultModelDescription"),
          storeKey: "selectedModel" as const,
          filter: (_model: ModelInfo): boolean => true,
        },
  )

  const groups = createMemo(() => {
    const query = search().toLowerCase()
    return configStore.connectedProviders
      .map((provider) => ({
        id: provider.id,
        name: provider.name,
        models: provider.models.filter((model) => meta().filter(model) && model.name.toLowerCase().includes(query)),
      }))
      .filter((group) => group.models.length > 0)
  })

  const selectedValue = () => configStore[meta().storeKey]

  const setSelected = (value: string) => {
    setConfigStore(meta().storeKey, value)
    resetCoreValidation()
  }

  const toggleGroup = (id: string) => {
    setCollapsed((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const formatContext = (size: number) => {
    if (size >= 1_000_000) return `${(size / 1_000_000).toFixed(1)}M`
    if (size >= 1_000) return `${Math.round(size / 1_000)}K`
    return String(size)
  }

  return (
    <div class="su-required-card">
      <div class="su-onboarding-header-row">
        <div>
          <div class="su-section-label">
            {props.category === "vision" ? t("chooseVisionEyebrow") : t("chooseDefaultEyebrow")}
          </div>
          <h2 class="su-required-title">{meta().title}</h2>
          <p class="su-required-copy">{meta().description}</p>
        </div>
        <Show when={selectedValue()}>
          <StatusPill tone="success">{t("chooseSelectedState")}</StatusPill>
        </Show>
      </div>

      <div class="max-w-md">
        <TextField
          label={meta().title}
          hideLabel
          placeholder={t("modelsSearchPlaceholder")}
          value={search()}
          onChange={setSearch}
        />
      </div>

      <div class="su-model-list-shell">
        <div class="su-model-list-scroll">
          <For each={groups()}>
            {(group) => {
              const isCollapsed = () => collapsed().has(group.id)

              return (
                <div class="su-model-column">
                  <button type="button" class="su-model-group" onClick={() => toggleGroup(group.id)}>
                    <div class="flex items-center gap-2">
                      <Icon
                        name="chevron-right"
                        size="small"
                        class="transition-transform duration-150"
                        classList={{ "rotate-90": !isCollapsed() }}
                      />
                      <span class="text-12-medium uppercase tracking-wider text-text-weaker">{group.name}</span>
                    </div>
                    <span class="text-12-regular text-text-weaker">{group.models.length}</span>
                  </button>

                  <Show when={!isCollapsed()}>
                    <div class="mt-3 grid gap-2">
                      <For each={group.models}>
                        {(model) => {
                          const value = `${group.id}/${model.id}`
                          const selected = () => selectedValue() === value

                          return (
                            <div
                              role="radio"
                              aria-checked={selected()}
                              tabIndex={0}
                              class="su-model-card"
                              classList={{ "su-model-card-active": selected() }}
                              onClick={() => setSelected(value)}
                              onKeyDown={(event) => {
                                if (event.key !== "Enter" && event.key !== " ") return
                                event.preventDefault()
                                setSelected(value)
                              }}
                            >
                              <div class="su-model-card-main">
                                <div class="su-model-card-title">{model.name}</div>
                                <div class="su-model-card-tags">
                                  <Show when={model.reasoning}>
                                    <Tag tone="warning">{t("modelsReasoning")}</Tag>
                                  </Show>
                                  <Show when={model.multimodal}>
                                    <Tag tone="info">{t("modelsMultimodal")}</Tag>
                                  </Show>
                                </div>
                                <span class="su-model-card-provider">{group.name}</span>
                              </div>

                              <div class="su-model-card-meta">
                                <div class="su-model-context-badge">
                                  <span class="su-model-context-value">{formatContext(model.context)}</span>
                                  <span class="su-model-context-label">{t("modelsContextSuffix")}</span>
                                </div>
                                <Show when={selected()}>
                                  <Icon name="check" class="su-model-card-check" />
                                </Show>
                              </div>
                            </div>
                          )
                        }}
                      </For>
                    </div>
                  </Show>
                </div>
              )
            }}
          </For>

          <Show when={groups().length === 0}>
            <p class="su-empty-state">{search() ? t("modelsNoMatch") : t("modelsNoAvailable")}</p>
          </Show>
        </div>
      </div>
    </div>
  )
}

export const ChooseModelsPhase: Component = () => {
  const { t } = useDictionary()

  return (
    <div class="flex flex-col gap-6">
      <PageIntro eyebrow={t("chooseEyebrow")} title={t("chooseTitle")} copy={t("chooseDescription")} />

      <Show
        when={configStore.connectedProviders.length > 0}
        fallback={
          <SectionCard>
            <InlineAlert variant="info">{t("chooseNeedsProvider")}</InlineAlert>
          </SectionCard>
        }
      >
        <div class="grid gap-6 2xl:grid-cols-[1fr_1fr]">
          <SectionCard class="su-onboarding-panel">
            <ModelSelectionCard category="default" />
          </SectionCard>

          <SectionCard class="su-onboarding-panel">
            <ModelSelectionCard category="vision" />
          </SectionCard>
        </div>
      </Show>
    </div>
  )
}
