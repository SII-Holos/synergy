import { For, Show, createMemo, createSignal, type Component } from "solid-js"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { api } from "../api"
import { InlineAlert, PageIntro, SectionCard, StatusPill } from "../components"
import { useDictionary } from "../locale"
import { RECALL_PROVIDERS, type RecallProviderPreset } from "../recall-providers"
import {
  configStore,
  hasPartialRecallSetup,
  isRecallSkipped,
  resetCoreValidation,
  setConfigStore,
  type IdentityModelConfig,
} from "../store"

type SearchCategory = "embedding" | "rerank"

const SearchCard: Component<{ category: SearchCategory }> = (props) => {
  const { t } = useDictionary()
  const [discovering, setDiscovering] = createSignal(false)
  const [discoveredModels, setDiscoveredModels] = createSignal<Array<{ id: string; name: string }>>([])
  const [discoverError, setDiscoverError] = createSignal("")
  const [showDiscovered, setShowDiscovered] = createSignal(false)

  const meta = createMemo(() =>
    props.category === "embedding"
      ? {
          title: t("embeddingTitle"),
          description: t("embeddingDescription"),
          helper: t("recallEmbeddingHelper"),
          configKey: "embeddingConfig" as const,
          discoverType: "embedding" as const,
          placeholder: {
            baseURL: "https://api.siliconflow.cn/v1",
            model: "Qwen/Qwen3-Embedding-8B",
          },
        }
      : {
          title: t("rerankTitle"),
          description: t("rerankDescription"),
          helper: t("recallRerankHelper"),
          configKey: "rerankConfig" as const,
          discoverType: "rerank" as const,
          placeholder: {
            baseURL: "https://api.siliconflow.cn/v1",
            model: "Qwen/Qwen3-Reranker-8B",
          },
        },
  )

  const config = () => configStore[meta().configKey]

  const updateField = (field: keyof IdentityModelConfig, value: string) => {
    setConfigStore(meta().configKey, field, value)
    resetCoreValidation()
  }

  const handleDiscover = async () => {
    const { baseURL, apiKey } = config()
    if (!baseURL || !apiKey) return

    setDiscovering(true)
    setDiscoverError("")
    setDiscoveredModels([])

    try {
      const result = await api.discoverModels({
        baseURL,
        apiKey,
        type: meta().discoverType,
      })

      if (result.models.length === 0) {
        setDiscoverError(t("identityNoModelsFound"))
        return
      }

      setDiscoveredModels(result.models)
      setShowDiscovered(true)
    } catch {
      setDiscoverError(t("identityFetchFailed"))
    } finally {
      setDiscovering(false)
    }
  }

  const selectModel = (modelId: string) => {
    updateField("model", modelId)
    setShowDiscovered(false)
  }

  const ready = () => Boolean(config().baseURL && config().apiKey && config().model)

  return (
    <div class="su-required-card">
      <div class="su-required-card-head">
        <div class="min-w-0">
          <div class="su-section-label">{meta().helper}</div>
          <h2 class="su-required-title">{meta().title}</h2>
          <p class="su-required-copy">{meta().description}</p>
        </div>
        <div class="su-required-card-aside">
          <Show when={ready()}>
            <StatusPill tone="success">{t("recallReadyState")}</StatusPill>
          </Show>
        </div>
      </div>

      <div class="grid gap-4">
        <TextField
          label={t("identityBaseUrl")}
          placeholder={meta().placeholder.baseURL}
          value={config().baseURL}
          onChange={(value) => {
            updateField("baseURL", value)
            setShowDiscovered(false)
            setDiscoverError("")
          }}
        />

        <TextField
          label={t("identityApiKey")}
          type="password"
          placeholder="sk-..."
          value={config().apiKey}
          onChange={(value) => {
            updateField("apiKey", value)
            setShowDiscovered(false)
            setDiscoverError("")
          }}
        />

        <div>
          <div class="flex flex-col gap-3 xl:flex-row xl:items-end">
            <div class="flex-1">
              <TextField
                label={t("identityModel")}
                placeholder={meta().placeholder.model}
                value={config().model}
                onChange={(value) => updateField("model", value)}
              />
            </div>

            <Button
              variant="secondary"
              size="large"
              disabled={!config().baseURL || !config().apiKey || discovering()}
              onClick={handleDiscover}
            >
              {discovering() ? t("identityFetchingModels") : t("identityFetchModels")}
            </Button>
          </div>

          <Show when={discoverError()}>
            <p class="mt-2 text-12-regular text-text-weaker">{discoverError()}</p>
          </Show>
        </div>

        <Show when={showDiscovered() && discoveredModels().length > 0}>
          <div>
            <div class="su-section-label">{t("identityAvailableModels")}</div>
            <div class="mt-3 grid gap-2 max-h-64 overflow-y-auto">
              <For each={discoveredModels()}>
                {(model) => {
                  const selected = () => config().model === model.id

                  return (
                    <div
                      role="radio"
                      aria-checked={selected()}
                      tabIndex={0}
                      class="su-model-card"
                      classList={{ "su-model-card-active": selected() }}
                      onClick={() => selectModel(model.id)}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return
                        event.preventDefault()
                        selectModel(model.id)
                      }}
                    >
                      <span class="text-13-medium text-text-strong">{model.name}</span>
                      <Show when={selected()}>
                        <Icon name="check" size="small" style={{ color: "var(--su-info-text)" }} />
                      </Show>
                    </div>
                  )
                }}
              </For>
            </div>
          </div>
        </Show>
      </div>
    </div>
  )
}

const RecallProviderCard: Component<{ preset: RecallProviderPreset }> = (props) => {
  const { t } = useDictionary()

  const applyPreset = () => {
    setConfigStore("embeddingConfig", {
      baseURL: props.preset.embedding.baseURL,
      apiKey: configStore.embeddingConfig.apiKey,
      model: props.preset.embedding.model,
    })
    setConfigStore("rerankConfig", {
      baseURL: props.preset.rerank.baseURL,
      apiKey: configStore.rerankConfig.apiKey,
      model: props.preset.rerank.model,
    })
    resetCoreValidation()
  }

  return (
    <div class="su-recall-provider-card">
      <div class="su-recall-provider-card-body">
        <div class="su-recall-provider-card-name">{t(props.preset.nameKey)}</div>
        <div class="su-recall-provider-card-desc">{t(props.preset.descKey)}</div>
      </div>
      <div class="su-recall-provider-card-actions">
        <a class="su-provider-key-link" href={props.preset.keysUrl} target="_blank" rel="noopener noreferrer">
          <Icon name="arrow-up-right" size="small" />
          {t("providerGetKey")}
        </a>
        <Button variant="secondary" size="small" onClick={applyPreset}>
          {t("recallProviderApply")}
        </Button>
      </div>
    </div>
  )
}

export const SearchSetupPhase: Component = () => {
  const { t } = useDictionary()

  return (
    <div class="flex flex-col gap-6">
      <PageIntro eyebrow={t("recallEyebrow")} title={t("recallTitle")} copy={t("recallDescription")} />

      <Show when={isRecallSkipped(configStore)}>
        <InlineAlert variant="info">{t("recallSkipBanner")}</InlineAlert>
      </Show>

      <Show when={hasPartialRecallSetup(configStore)}>
        <InlineAlert variant="warning">{t("recallPartialWarning")}</InlineAlert>
      </Show>

      <div class="grid gap-6 2xl:grid-cols-[1fr_1fr]">
        <SectionCard class="su-onboarding-panel">
          <SearchCard category="embedding" />
        </SectionCard>

        <SectionCard class="su-onboarding-panel">
          <SearchCard category="rerank" />
        </SectionCard>
      </div>

      <SectionCard class="su-onboarding-panel">
        <div class="su-recall-providers-header">
          <div class="su-section-label">{t("recallProvidersSectionTitle")}</div>
          <p class="su-recall-providers-desc">{t("recallProvidersSectionDesc")}</p>
        </div>
        <div class="su-recall-providers-grid">
          <For each={RECALL_PROVIDERS}>{(preset) => <RecallProviderCard preset={preset} />}</For>
        </div>
      </SectionCard>
    </div>
  )
}
