import { For, Show, createMemo, createSignal, type Component } from "solid-js"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { api } from "../api"
import { InlineAlert, PageIntro, SectionCard, StatusPill, ValidationCard } from "../components"
import { useDictionary } from "../locale"
import { configStore, getRequiredCorePayload, isRecallSkipped, setConfigStore, type CoreField } from "../store"

export const ValidateCorePhase: Component = () => {
  const { t } = useDictionary()
  const [running, setRunning] = createSignal(false)
  const [error, setError] = createSignal("")

  const recallSkipped = () => isRecallSkipped(configStore)

  const entries = createMemo<Array<{ key: CoreField; label: string; value: string; skipped: boolean }>>(() => [
    {
      key: "model",
      label: t("summaryDefaultModel"),
      value: configStore.selectedModel || t("notSelected"),
      skipped: false,
    },
    {
      key: "vision_model",
      label: t("summaryVisionModel"),
      value: configStore.selectedVisionModel || t("notSelected"),
      skipped: false,
    },
    {
      key: "embedding",
      label: t("embeddingTitle"),
      value: recallSkipped() ? t("validateSkippedField") : configStore.embeddingConfig.model || t("notConfigured"),
      skipped: recallSkipped(),
    },
    {
      key: "rerank",
      label: t("rerankTitle"),
      value: recallSkipped() ? t("validateSkippedField") : configStore.rerankConfig.model || t("notConfigured"),
      skipped: recallSkipped(),
    },
  ])

  const handleValidate = async () => {
    setRunning(true)
    setError("")
    setConfigStore("coreValidation", "status", "running")
    setConfigStore("coreValidation", "error", "")

    try {
      const validation = await api.validateRequiredCore(getRequiredCorePayload(configStore))
      setConfigStore("coreValidation", {
        status: validation.valid ? "passed" : "failed",
        error: "",
        result: validation,
      })
    } catch (validationError: any) {
      const message = validationError.message || t("validateCoreFailed")
      setError(message)
      setConfigStore("coreValidation", {
        status: "failed",
        error: message,
        result: configStore.coreValidation.result,
      })
    } finally {
      setRunning(false)
    }
  }

  return (
    <div class="flex flex-col gap-6">
      <PageIntro eyebrow={t("validateEyebrow")} title={t("validateTitle")} copy={t("validateDescription")} />

      <SectionCard class="su-onboarding-panel">
        <div class="flex flex-col gap-5">
          <div>
            <div class="su-section-label">{t("validateSummaryEyebrow")}</div>
            <h2 class="su-required-title">{t("validateSummaryTitle")}</h2>
            <p class="su-required-copy">{t("validateSummaryDescription")}</p>
          </div>

          <div class="su-finish-grid">
            <For each={entries()}>
              {(entry) => {
                const field = () => configStore.coreValidation.result?.fields?.[entry.key]
                const tone = () => {
                  if (entry.skipped) return "neutral" as const
                  if (!field()) return undefined
                  return field()!.valid ? "success" : "critical"
                }

                return (
                  <ValidationCard tone={tone()}>
                    <div class="su-validation-title">{entry.label}</div>
                    <div class="su-finish-model-value">{entry.value}</div>
                    <Show when={!entry.skipped && field()}>
                      <div class="su-validation-copy">{field()!.message}</div>
                    </Show>
                  </ValidationCard>
                )
              }}
            </For>
          </div>

          <Show when={error()}>
            <InlineAlert variant="error">{error()}</InlineAlert>
          </Show>

          <div class="flex items-center gap-3">
            <Button variant="primary" size="large" disabled={running()} onClick={handleValidate}>
              {running() ? t("validateRunning") : t("validateAction")}
            </Button>
            <Show when={configStore.coreValidation.status === "passed"}>
              <StatusPill tone="success">{t("validatePassed")}</StatusPill>
            </Show>
            <Show when={configStore.coreValidation.status === "failed"}>
              <StatusPill tone="critical">{t("validateFailed")}</StatusPill>
            </Show>
          </div>
        </div>
      </SectionCard>
    </div>
  )
}
