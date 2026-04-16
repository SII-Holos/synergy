import { createMemo, createSignal, For, Show, type Component } from "solid-js"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { api } from "../api"
import { InlineAlert } from "../components"
import { useDictionary } from "../locale"
import { ROLE_META } from "../role-meta"
import { configStore, getFinalizePayload, isRecallSkipped, setConfigStore, type RoleKey } from "../store"

const CORE_ROLE_KEYS = ["model", "vision_model", "embedding", "rerank"] as const

type FinishEntry = {
  key: string
  label: string
  value: string
  description?: string
  badge: string
  state: "required" | "optional" | "fallback"
}

function getImportedIdentityModel(key: "embedding" | "rerank") {
  const identity = configStore.importedConfig?.identity
  if (!identity || typeof identity !== "object") return ""
  const section = (identity as Record<string, unknown>)[key]
  if (!section || typeof section !== "object") return ""
  const model = (section as { model?: unknown }).model
  return typeof model === "string" ? model : ""
}

function isImportRecallConfigured() {
  return Boolean(getImportedIdentityModel("embedding") && getImportedIdentityModel("rerank"))
}

export const FinishPhase: Component = () => {
  const { t } = useDictionary()
  const [error, setError] = createSignal("")

  const isImportFlow = createMemo(() => configStore.intent === "import")

  const roleMetaMap = createMemo(
    () =>
      new Map(ROLE_META.map((role) => [role.key, { label: t(role.labelKey), description: t(role.descriptionKey) }])),
  )

  const providerEntries = createMemo(() => {
    if (isImportFlow()) {
      return configStore.importedProviders.map((provider) => ({
        name: provider,
        meta: t("finishImportedFromConfig"),
      }))
    }

    return configStore.connectedProviders.map((provider) => ({
      name: provider.name,
      meta:
        provider.modelCountStatus === "verified" && provider.accountModelCount !== undefined
          ? `${t("providersModelsAvailablePrefix")} ${provider.accountModelCount} / ${t("providersModelsCatalogPrefix")} ${provider.catalogModelCount}`
          : `${t("providersModelsCatalogPrefix")} ${provider.catalogModelCount}`,
    }))
  })

  const recallSkipped = createMemo(() => (isImportFlow() ? !isImportRecallConfigured() : isRecallSkipped(configStore)))

  const coreEntries = createMemo<FinishEntry[]>(() => {
    const skipped = recallSkipped()

    if (isImportFlow()) {
      return [
        {
          key: "model",
          label: t("summaryDefaultModel"),
          value:
            typeof configStore.importedConfig?.model === "string" ? configStore.importedConfig.model : t("notSelected"),
          badge: t("finishRequiredBadge"),
          state: "required",
        },
        {
          key: "vision_model",
          label: t("summaryVisionModel"),
          value:
            typeof configStore.importedConfig?.vision_model === "string"
              ? configStore.importedConfig.vision_model
              : t("notSelected"),
          badge: t("finishRequiredBadge"),
          state: "required",
        },
        {
          key: "embedding",
          label: t("embeddingTitle"),
          value: getImportedIdentityModel("embedding") || t("notConfigured"),
          badge: getImportedIdentityModel("embedding") ? t("finishRecommendedBadge") : t("finishFallbackBadge"),
          state: getImportedIdentityModel("embedding") ? "optional" : "fallback",
        },
        {
          key: "rerank",
          label: t("rerankTitle"),
          value: getImportedIdentityModel("rerank") || t("notConfigured"),
          badge: getImportedIdentityModel("rerank") ? t("finishRecommendedBadge") : t("finishFallbackBadge"),
          state: getImportedIdentityModel("rerank") ? "optional" : "fallback",
        },
      ]
    }

    return [
      {
        key: "model",
        label: t("summaryDefaultModel"),
        value: configStore.selectedModel || t("notSelected"),
        badge: t("finishRequiredBadge"),
        state: "required",
      },
      {
        key: "vision_model",
        label: t("summaryVisionModel"),
        value: configStore.selectedVisionModel || t("notSelected"),
        badge: t("finishRequiredBadge"),
        state: "required",
      },
      {
        key: "embedding",
        label: t("embeddingTitle"),
        value: skipped ? t("notConfigured") : configStore.embeddingConfig.model || t("notConfigured"),
        badge: skipped ? t("finishFallbackBadge") : t("finishRecommendedBadge"),
        state: skipped ? "fallback" : "optional",
      },
      {
        key: "rerank",
        label: t("rerankTitle"),
        value: skipped ? t("notConfigured") : configStore.rerankConfig.model || t("notConfigured"),
        badge: skipped ? t("finishFallbackBadge") : t("finishRecommendedBadge"),
        state: skipped ? "fallback" : "optional",
      },
    ]
  })

  const optionalEntries = createMemo<FinishEntry[]>(() => {
    if (isImportFlow()) {
      return ROLE_META.map((role) => {
        const value = configStore.importedRoles[role.key]
        const meta = roleMetaMap().get(role.key)
        return {
          key: role.key,
          label: meta?.label || role.key,
          description: meta?.description,
          value: value || t("defaultRoleFallback"),
          badge: value ? t("finishOptionalBadge") : t("finishFallbackBadge"),
          state: value ? "optional" : "fallback",
        } satisfies FinishEntry
      })
    }

    return ROLE_META.map((role) => {
      const value = configStore.roles[role.key as RoleKey]
      return {
        key: role.key,
        label: t(role.labelKey),
        description: t(role.descriptionKey),
        value: value || t("defaultRoleFallback"),
        badge: value ? t("finishOptionalBadge") : t("finishFallbackBadge"),
        state: value ? "optional" : "fallback",
      } satisfies FinishEntry
    })
  })

  const activeOptionalCount = createMemo(() => optionalEntries().filter((entry) => entry.state === "optional").length)

  const handleSave = async () => {
    setConfigStore("saving", true)
    setError("")

    try {
      if (isImportFlow()) {
        const importedConfig = configStore.importedConfig
        if (!importedConfig) {
          throw new Error(t("importValidationFailed"))
        }

        const response = await api.importConfig(importedConfig)
        setConfigStore("saved", true)
        if (response.filepath) setConfigStore("configPath", response.filepath)
        return
      }

      const response = await api.finalizeSetup(getFinalizePayload(configStore))
      if (!response.ok) return

      setConfigStore("saved", true)
      if (response.filepath) setConfigStore("configPath", response.filepath)
    } catch (saveError: any) {
      setError(saveError.message || t("providersSaveFailed"))
    } finally {
      setConfigStore("saving", false)
    }
  }

  return (
    <div class="flex flex-col gap-6">
      <div class="max-w-4xl">
        <h1 class="su-page-title">{isImportFlow() ? t("finishImportTitle") : t("finishTitle")}</h1>
        <p class="su-page-copy mt-3">{isImportFlow() ? t("finishImportDescription") : t("finishDescription")}</p>
      </div>

      <Show
        when={!configStore.saved}
        fallback={
          <section class="su-card max-w-3xl">
            <div class="su-finish-success">
              <div class="su-finish-icon">
                <Icon name="check" size="large" />
              </div>
              <h2 class="text-20-medium text-text-strong">{t("configSaved")}</h2>
              <Show when={configStore.configPath}>
                <p class="text-13-medium text-text-weak break-all">{configStore.configPath}</p>
              </Show>
              <p class="text-14-regular text-text-weak">{t("configSavedHint")}</p>
              <Button
                variant="primary"
                size="large"
                onClick={() => {
                  if (typeof window !== "undefined") window.close()
                }}
              >
                {t("configSavedDone")}
              </Button>
            </div>
          </section>
        }
      >
        <div class="grid gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
          <div class="flex flex-col gap-6">
            <section class="su-card su-finish-hero">
              <div class="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
                <div class="max-w-2xl">
                  <div class="su-section-label">
                    {isImportFlow() ? t("finishImportSummaryTitle") : t("finishManualSummaryTitle")}
                  </div>
                  <h2 class="mt-3 su-finish-hero-title">
                    {isImportFlow() ? t("importedComplete") : t("finishManualTitle")}
                  </h2>
                  <p class="mt-3 su-finish-hero-copy">
                    {isImportFlow() ? t("finishImportLead") : t("finishManualLead")}
                  </p>
                </div>

                <div class="su-finish-badges">
                  <span class="su-tag su-tag-info">{t("finishRequiredBadge")}</span>
                  <span class="su-tag su-tag-neutral">
                    {activeOptionalCount()} / {ROLE_META.length} {t("finishOptionalBadge")}
                  </span>
                </div>
              </div>
            </section>

            <section class="su-card">
              <div class="flex flex-col gap-2">
                <div class="su-section-label">{t("finishCoreTitle")}</div>
                <h3 class="su-finish-section-title">{t("finishCoreTitle")}</h3>
                <p class="su-finish-section-copy">{t("finishCoreDescription")}</p>
              </div>

              <Show when={recallSkipped()}>
                <div class="mt-4">
                  <InlineAlert variant="info">{t("finishRecallSkippedNote")}</InlineAlert>
                </div>
              </Show>

              <div class="su-finish-grid mt-5">
                <For each={coreEntries()}>
                  {(entry) => (
                    <article
                      class="su-finish-model-card"
                      classList={{
                        "su-finish-model-card-required": entry.state === "required",
                        "su-finish-model-card-recommended": entry.state === "optional",
                        "su-finish-model-card-skipped": entry.state === "fallback",
                      }}
                    >
                      <div class="su-finish-model-topline">
                        <span class="su-finish-model-label">{entry.label}</span>
                        <span
                          class="su-pill"
                          classList={{
                            "su-pill-info": entry.state === "required" || entry.state === "optional",
                            "su-pill-neutral": entry.state === "fallback",
                          }}
                        >
                          {entry.badge}
                        </span>
                      </div>
                      <div class="su-finish-model-value">{entry.value}</div>
                      <div class="su-finish-model-foot">
                        {entry.state === "required"
                          ? t("finishRequiredState")
                          : entry.state === "optional"
                            ? t("finishRecommendedState")
                            : t("finishFallbackState")}
                      </div>
                    </article>
                  )}
                </For>
              </div>
            </section>

            <section class="su-card">
              <div class="flex flex-col gap-2">
                <div class="su-section-label">{t("finishOptionalTitle")}</div>
                <h3 class="su-finish-section-title">{t("finishOptionalTitle")}</h3>
                <p class="su-finish-section-copy">{t("finishOptionalDescription")}</p>
              </div>

              <div class="su-finish-role-list mt-5">
                <For each={optionalEntries()}>
                  {(entry) => (
                    <article
                      class={`su-finish-role-card ${
                        entry.state === "optional" ? "su-finish-role-card-optional" : "su-finish-role-card-fallback"
                      }`}
                    >
                      <div class="su-finish-role-main">
                        <div class="su-finish-role-header">
                          <div>
                            <div class="su-finish-role-label">{entry.label}</div>
                            <Show when={entry.description}>
                              <p class="su-finish-role-copy">{entry.description}</p>
                            </Show>
                          </div>
                          <span class={`su-pill ${entry.state === "optional" ? "su-pill-info" : "su-pill-neutral"}`}>
                            {entry.badge}
                          </span>
                        </div>
                        <div class="su-finish-role-value">{entry.value}</div>
                      </div>
                    </article>
                  )}
                </For>
              </div>
            </section>
          </div>

          <aside class="flex flex-col gap-6">
            <section class="su-card h-fit">
              <div class="flex flex-col gap-4">
                <div>
                  <div class="su-section-label">{t("finishProviderTitle")}</div>
                  <h3 class="mt-3 su-finish-section-title">{t("finishProviderTitle")}</h3>
                  <p class="mt-2 su-finish-section-copy">{t("finishProviderDescription")}</p>
                </div>

                <div class="su-review-list">
                  <For each={providerEntries()}>
                    {(entry) => (
                      <div class="su-field-row su-finish-provider-row">
                        <span class="su-finish-provider-name">{entry.name}</span>
                        <span class="su-finish-provider-meta">{entry.meta}</span>
                      </div>
                    )}
                  </For>
                  <Show when={providerEntries().length === 0}>
                    <div class="su-field-row">
                      {isImportFlow() ? t("finishEmptyProviders") : t("noProvidersConnected")}
                    </div>
                  </Show>
                </div>
              </div>
            </section>

            <section class="su-card h-fit">
              <div class="flex flex-col gap-5">
                <div>
                  <div class="su-section-label">{t("phaseFinish")}</div>
                  <h3 class="mt-3 su-finish-section-title">{t("finishSaveTitle")}</h3>
                  <p class="mt-2 su-finish-section-copy">
                    {isImportFlow() ? t("finishImportActionHint") : t("finishManualActionHint")}
                  </p>
                </div>

                <Show when={error()}>
                  <InlineAlert variant="error">{error()}</InlineAlert>
                </Show>

                <Button
                  variant="primary"
                  size="large"
                  class="w-full"
                  disabled={configStore.saving}
                  onClick={handleSave}
                >
                  {isImportFlow() ? t("finishImport") : configStore.saving ? t("saving") : t("saveAndFinish")}
                </Button>
              </div>
            </section>
          </aside>
        </div>
      </Show>
    </div>
  )
}
