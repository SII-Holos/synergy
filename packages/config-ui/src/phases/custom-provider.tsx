import { For, Show, createEffect, createSignal, type Component } from "solid-js"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import {
  api,
  type CustomProviderAdapter,
  type CustomProviderCredentialMode,
  type CustomProviderModelDraft,
} from "../api"
import { CodePanel, InlineAlert, PageIntro, SectionCard, Tag } from "../components"
import { useDictionary } from "../locale"
import { configStore, createEmptyCustomProviderDraft, resetCoreValidation, setConfigStore } from "../store"

const ADAPTER_OPTIONS: Array<{ value: CustomProviderAdapter; npm: string }> = [
  { value: "openai-compatible", npm: "@ai-sdk/openai-compatible" },
  { value: "anthropic", npm: "@ai-sdk/anthropic" },
  { value: "google", npm: "@ai-sdk/google" },
  { value: "openai", npm: "@ai-sdk/openai" },
  { value: "azure", npm: "@ai-sdk/azure" },
  { value: "groq", npm: "@ai-sdk/groq" },
  { value: "mistral", npm: "@ai-sdk/mistral" },
  { value: "xai", npm: "@ai-sdk/xai" },
]

const CREDENTIAL_OPTIONS: Array<{ value: CustomProviderCredentialMode; labelKey: string }> = [
  { value: "synergy", labelKey: "customProviderCredentialSynergy" },
  { value: "env", labelKey: "customProviderCredentialEnv" },
  { value: "inline", labelKey: "customProviderCredentialInline" },
]

function parseList(value: string) {
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function stringifyRecord(value?: Record<string, unknown>) {
  if (!value || Object.keys(value).length === 0) return ""
  return JSON.stringify(value, null, 2)
}

function parseRecord(value: string) {
  const text = value.trim()
  if (!text) return {}
  return JSON.parse(text) as Record<string, unknown>
}

export const CustomProviderPhase: Component<{ onDone: () => void; onCancel: () => void }> = (props) => {
  const { t } = useDictionary()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const [success, setSuccess] = createSignal("")
  const [previewText, setPreviewText] = createSignal("")
  const [discovered, setDiscovered] = createSignal<Array<{ id: string; name: string }>>([])
  const [optionsText, setOptionsText] = createSignal(stringifyRecord(configStore.customProviderDraft.options))

  const draft = () => configStore.customProviderDraft
  const selectedAdapter = () => ADAPTER_OPTIONS.find((item) => item.value === draft().adapter)

  const updateDraft = (key: keyof ReturnType<typeof draft>, value: unknown) => {
    setConfigStore("customProviderDraft", key as any, value as never)
  }

  createEffect(() => {
    setOptionsText(stringifyRecord(draft().options))
  })

  const updateModel = (index: number, patch: Partial<CustomProviderModelDraft>) => {
    for (const [key, value] of Object.entries(patch)) {
      setConfigStore("customProviderDraft", "models", index, key as keyof CustomProviderModelDraft, value as never)
    }
  }

  const addModel = () => {
    updateDraft("models", [
      ...draft().models,
      {
        key: "",
        id: "",
        name: "",
        family: "",
        modalities: { input: ["text"], output: ["text"] },
        limit: { context: 0, output: 0 },
        cost: {},
        headers: {},
        options: {},
      },
    ])
  }

  const removeModel = (index: number) => {
    if (draft().models.length === 1) {
      updateDraft("models", [createEmptyCustomProviderDraft().models[0]])
      return
    }
    updateDraft(
      "models",
      draft().models.filter((_, modelIndex) => modelIndex !== index),
    )
  }

  const stageConnectedProvider = async () => {
    const result = await api.verifyCustomProvider(draft())
    if (!result.preview || !result.ok) {
      throw new Error(result.error || t("customProviderVerifyFailed"))
    }

    const providerID = result.preview.providerID

    setConfigStore("providerDrafts", providerID, result.preview.config as any)

    if (draft().credentialMode === "synergy" && draft().apiKey) {
      setConfigStore("stagedAuth", providerID, { mode: "set", key: draft().apiKey })
    } else {
      setConfigStore("stagedAuth", providerID, { mode: "remove" })
    }
  }

  const runPreview = async () => {
    setBusy(true)
    setError("")
    setSuccess("")
    try {
      const preview = await api.previewCustomProvider(draft())
      setPreviewText(JSON.stringify(preview.config, null, 2))
      setDiscovered(preview.discoveredModels)
    } catch (previewError: any) {
      setError(previewError.message || t("customProviderPreviewFailed"))
    } finally {
      setBusy(false)
    }
  }

  const runVerify = async () => {
    setBusy(true)
    setError("")
    setSuccess("")
    try {
      const result = await api.verifyCustomProvider(draft())
      setPreviewText(result.preview ? JSON.stringify(result.preview.config, null, 2) : "")
      setDiscovered(result.models)
      if (!result.ok) {
        setError(result.error || t("customProviderVerifyFailed"))
        return
      }
      setSuccess(result.message || t("customProviderVerifyPassed"))
    } catch (verifyError: any) {
      setError(verifyError.message || t("customProviderVerifyFailed"))
    } finally {
      setBusy(false)
    }
  }

  const handleSave = async () => {
    setBusy(true)
    setError("")
    setSuccess("")
    try {
      await stageConnectedProvider()
      resetCoreValidation()
      setSuccess(t("customProviderSaved"))
      setConfigStore("customProviderDraft", createEmptyCustomProviderDraft())
      props.onDone()
    } catch (saveError: any) {
      setError(saveError.message || t("customProviderSaveFailed"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="flex flex-col gap-6">
      <PageIntro
        eyebrow={t("customProviderEyebrow")}
        title={t("customProviderTitle")}
        copy={t("customProviderDescription")}
      />

      <Show when={error()}>
        <InlineAlert variant="error">{error()}</InlineAlert>
      </Show>
      <Show when={success()}>
        <InlineAlert variant="info">{success()}</InlineAlert>
      </Show>

      <SectionCard class="su-onboarding-panel">
        <div class="su-custom-provider-grid">
          <div class="su-custom-provider-section">
            <div class="su-section-label">{t("customProviderBasics")}</div>
            <div class="grid gap-4 md:grid-cols-2">
              <TextField
                label={t("customProviderId")}
                value={draft().id}
                onChange={(value) => updateDraft("id", value)}
              />
              <TextField
                label={t("customProviderName")}
                value={draft().name}
                onChange={(value) => updateDraft("name", value)}
              />
            </div>
            <div class="grid gap-4 md:grid-cols-2">
              <label class="su-custom-provider-select-wrap">
                <span class="su-custom-provider-label">{t("customProviderAdapter")}</span>
                <select
                  class="su-custom-provider-select"
                  value={draft().adapter}
                  onChange={(event) => updateDraft("adapter", event.currentTarget.value as CustomProviderAdapter)}
                >
                  <For each={ADAPTER_OPTIONS}>{(option) => <option value={option.value}>{option.value}</option>}</For>
                </select>
              </label>
              <TextField
                label={t("customProviderNpmOverride")}
                value={draft().npm || selectedAdapter()?.npm || ""}
                onChange={(value) => updateDraft("npm", value)}
              />
            </div>
            <TextField
              label={t("customProviderApi")}
              value={draft().api}
              onChange={(value) => updateDraft("api", value)}
            />
            <TextField
              label={t("customProviderEnv")}
              value={draft().env.join(", ")}
              onChange={(value) => updateDraft("env", parseList(value))}
            />
          </div>

          <div class="su-custom-provider-section">
            <div class="su-section-label">{t("customProviderAuth")}</div>
            <div class="su-custom-provider-choice-row">
              <For each={CREDENTIAL_OPTIONS}>
                {(option) => (
                  <button
                    type="button"
                    class="su-choice-chip"
                    classList={{ "su-choice-chip-active": draft().credentialMode === option.value }}
                    onClick={() => updateDraft("credentialMode", option.value)}
                  >
                    {t(option.labelKey as any)}
                  </button>
                )}
              </For>
            </div>
            <Show when={draft().credentialMode !== "env"}>
              <TextField
                type="password"
                label={t("providersApiKey")}
                value={draft().apiKey || ""}
                onChange={(value) => updateDraft("apiKey", value)}
              />
            </Show>
            <div class="grid gap-4 md:grid-cols-2">
              <div>
                <div class="su-custom-provider-label">{t("customProviderProviderOptions")}</div>
                <textarea
                  class="su-custom-provider-textarea"
                  value={optionsText()}
                  onInput={(event) => {
                    const value = event.currentTarget.value
                    setOptionsText(value)
                    try {
                      updateDraft("options", parseRecord(value))
                      setError("")
                    } catch {
                      setError(t("customProviderJsonInvalid"))
                    }
                  }}
                />
              </div>
            </div>
          </div>
        </div>
      </SectionCard>

      <SectionCard class="su-onboarding-panel">
        <div class="flex items-center justify-between gap-4">
          <div>
            <div class="su-section-label">{t("customProviderModels")}</div>
            <h2 class="su-required-title">{t("customProviderModelsTitle")}</h2>
          </div>
          <Button variant="secondary" size="small" onClick={addModel}>
            {t("customProviderAddModel")}
          </Button>
        </div>
        <div class="mt-5 flex flex-col gap-5">
          <For each={draft().models}>
            {(model, index) => (
              <div class="su-custom-provider-model-card">
                <div class="flex items-center justify-between gap-4">
                  <div class="text-13-medium text-text-strong">{model.name || t("customProviderModelUntitled")}</div>
                  <Button variant="ghost" size="small" onClick={() => removeModel(index())}>
                    {t("customProviderRemoveModel")}
                  </Button>
                </div>
                <div class="grid gap-4 md:grid-cols-3">
                  <TextField
                    label={t("customProviderModelKey")}
                    value={model.key}
                    onChange={(value) => updateModel(index(), { key: value })}
                  />
                  <TextField
                    label={t("customProviderModelId")}
                    value={model.id}
                    onChange={(value) => updateModel(index(), { id: value })}
                  />
                  <TextField
                    label={t("customProviderModelName")}
                    value={model.name}
                    onChange={(value) => updateModel(index(), { name: value })}
                  />
                </div>
                <div class="grid gap-4 md:grid-cols-3">
                  <TextField
                    label={t("customProviderModelFamily")}
                    value={model.family || ""}
                    onChange={(value) => updateModel(index(), { family: value })}
                  />
                  <TextField
                    label={t("customProviderModelInput")}
                    value={(model.modalities?.input || []).join(", ")}
                    onChange={(value) =>
                      updateModel(index(), { modalities: { ...(model.modalities || {}), input: parseList(value) } })
                    }
                  />
                  <TextField
                    label={t("customProviderModelOutput")}
                    value={(model.modalities?.output || []).join(", ")}
                    onChange={(value) =>
                      updateModel(index(), { modalities: { ...(model.modalities || {}), output: parseList(value) } })
                    }
                  />
                </div>
                <div class="grid gap-4 md:grid-cols-4">
                  <TextField
                    label={t("customProviderModelContext")}
                    value={String(model.limit?.context ?? "")}
                    onChange={(value) =>
                      updateModel(index(), {
                        limit: { ...(model.limit || {}), context: value ? Number(value) : undefined },
                      })
                    }
                  />
                  <TextField
                    label={t("customProviderModelOutputLimit")}
                    value={String(model.limit?.output ?? "")}
                    onChange={(value) =>
                      updateModel(index(), {
                        limit: { ...(model.limit || {}), output: value ? Number(value) : undefined },
                      })
                    }
                  />
                  <TextField
                    label={t("customProviderModelCostInput")}
                    value={String(model.cost?.input ?? "")}
                    onChange={(value) =>
                      updateModel(index(), {
                        cost: { ...(model.cost || {}), input: value ? Number(value) : undefined },
                      })
                    }
                  />
                  <TextField
                    label={t("customProviderModelCostOutput")}
                    value={String(model.cost?.output ?? "")}
                    onChange={(value) =>
                      updateModel(index(), {
                        cost: { ...(model.cost || {}), output: value ? Number(value) : undefined },
                      })
                    }
                  />
                </div>
                <div class="su-custom-provider-choice-row">
                  <button
                    type="button"
                    class="su-choice-chip"
                    classList={{ "su-choice-chip-active": !!model.reasoning }}
                    onClick={() => updateModel(index(), { reasoning: !model.reasoning })}
                  >
                    {t("modelsReasoning")}
                  </button>
                  <button
                    type="button"
                    class="su-choice-chip"
                    classList={{ "su-choice-chip-active": !!model.attachment }}
                    onClick={() => updateModel(index(), { attachment: !model.attachment })}
                  >
                    {t("customProviderAttachment")}
                  </button>
                  <button
                    type="button"
                    class="su-choice-chip"
                    classList={{ "su-choice-chip-active": !!model.tool_call }}
                    onClick={() => updateModel(index(), { tool_call: !model.tool_call })}
                  >
                    {t("customProviderToolCall")}
                  </button>
                  <button
                    type="button"
                    class="su-choice-chip"
                    classList={{ "su-choice-chip-active": !!model.temperature }}
                    onClick={() => updateModel(index(), { temperature: !model.temperature })}
                  >
                    {t("customProviderTemperature")}
                  </button>
                </div>
              </div>
            )}
          </For>
        </div>
      </SectionCard>

      <SectionCard class="su-onboarding-panel">
        <div class="flex flex-wrap items-center gap-3">
          <Button variant="secondary" size="large" disabled={busy()} onClick={runPreview}>
            {t("customProviderPreviewAction")}
          </Button>
          <Button variant="secondary" size="large" disabled={busy()} onClick={runVerify}>
            {t("customProviderVerifyAction")}
          </Button>
          <Button variant="primary" size="large" disabled={busy()} onClick={handleSave}>
            {t("customProviderSaveAction")}
          </Button>
          <Button variant="ghost" size="large" disabled={busy()} onClick={props.onCancel}>
            {t("providersCancel")}
          </Button>
        </div>

        <Show when={discovered().length > 0}>
          <div class="mt-5 flex flex-wrap gap-2">
            <For each={discovered()}>{(model) => <Tag tone="info">{model.name}</Tag>}</For>
          </div>
        </Show>

        <Show when={previewText()}>
          <CodePanel class="mt-5">
            <pre class="su-code-pre">{previewText()}</pre>
          </CodePanel>
        </Show>
      </SectionCard>
    </div>
  )
}
