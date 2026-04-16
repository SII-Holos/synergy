import { For, Show, type Component } from "solid-js"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { parse, printParseErrorCode } from "jsonc-parser"
import { api } from "../api"
import { useDictionary } from "../locale"
import { StatusPill, ValidationCard, CodePanel, InlineAlert, type StatusTone } from "../components"
import { configStore, setConfigStore, type CoreValidationResult, type ImportStaticValidationResult } from "../store"

const emptyLiveValidationResult = (): CoreValidationResult => ({
  valid: false,
  fields: {
    model: { valid: false, message: "" },
    vision_model: { valid: false, message: "" },
    embedding: { valid: false, message: "" },
    rerank: { valid: false, message: "" },
  },
})

export const ImportStep: Component = () => {
  const { t } = useDictionary()
  let fileInputRef: HTMLInputElement | undefined

  const staticValidation = () => configStore.importDraft.validation.static
  const liveValidation = () => configStore.importDraft.validation.live
  const validating = () => staticValidation().status === "running" || liveValidation().status === "running"
  const importedConfigText = () => configStore.importDraft.raw
  const staticResult = () => staticValidation().result
  const liveResult = () => liveValidation().result
  const hasResult = () =>
    Boolean(staticResult()) || liveValidation().status === "passed" || liveValidation().status === "failed"

  const parseConfigText = (text: string) => {
    const errors: Array<{ error: number; offset: number; length: number }> = []
    const parsed = parse(text, errors)
    if (errors.length > 0) {
      const message = printParseErrorCode(errors[0].error)
      return { ok: false as const, message: `${t("importInvalidJson")}: ${message}` }
    }
    return { ok: true as const, value: parsed }
  }

  const resetImportedOutputs = () => {
    setConfigStore("importedConfig", null)
    setConfigStore("importedProviders", [])
    setConfigStore("importedRoles", {})
  }

  const resetValidationState = (text: string) => {
    setConfigStore("importDraft", "raw", text)
    setConfigStore("importDraft", "validation", {
      static: {
        status: "idle",
        error: "",
        result: null,
      },
      live: {
        status: "idle",
        error: "",
        result: emptyLiveValidationResult(),
      },
    })
    resetImportedOutputs()
  }

  const setStaticValidationError = (message: string) => {
    setConfigStore("importDraft", "validation", "static", {
      status: "failed",
      error: message,
      result: null,
    })
    setConfigStore("importDraft", "validation", "live", {
      status: "idle",
      error: "",
      result: emptyLiveValidationResult(),
    })
  }

  const handleValidate = async () => {
    const text = importedConfigText()
    resetImportedOutputs()
    setConfigStore("importDraft", "validation", {
      static: {
        status: "idle",
        error: "",
        result: null,
      },
      live: {
        status: "idle",
        error: "",
        result: emptyLiveValidationResult(),
      },
    })

    if (!text.trim()) return

    const parsedResult = parseConfigText(text)
    if (!parsedResult.ok) {
      setStaticValidationError(parsedResult.message)
      return
    }

    setConfigStore("importDraft", "validation", "static", "status", "running")

    try {
      const response = await api.validateConfig(parsedResult.value)
      const normalizedStatic: ImportStaticValidationResult = {
        valid: response.valid,
        config: response.config,
        providers: response.providers || [],
        roles: response.roles || {},
        warnings: response.warnings,
      }

      setConfigStore("importDraft", "validation", "static", {
        status: normalizedStatic.valid ? "passed" : "failed",
        error: "",
        result: normalizedStatic,
      })

      if (!normalizedStatic.valid || !normalizedStatic.config) {
        return
      }

      setConfigStore("importDraft", "validation", "live", "status", "running")

      const liveProbe = await api.probeImportedCore({
        config: normalizedStatic.config,
      })

      setConfigStore("importDraft", "validation", "live", {
        status: liveProbe.valid ? "passed" : "failed",
        error: "",
        result: liveProbe,
      })

      if (!liveProbe.valid) {
        return
      }

      setConfigStore("importedConfig", normalizedStatic.config)
      setConfigStore("importedProviders", normalizedStatic.providers)
      setConfigStore("importedRoles", normalizedStatic.roles)
    } catch (validationError: any) {
      const message = validationError.message || t("importValidationFailed")
      if (liveValidation().status === "running") {
        setConfigStore("importDraft", "validation", "live", {
          status: "failed",
          error: message,
          result: emptyLiveValidationResult(),
        })
        return
      }

      setStaticValidationError(message)
    }
  }

  const handleFile = async (file: File) => {
    const text = await file.text()
    resetValidationState(text)
  }

  const coreFieldEntries = () => {
    const validation = liveResult()
    if (!validation) return []
    return [
      { key: "model", label: t("summaryDefaultModel"), ...validation.fields.model },
      { key: "vision_model", label: t("summaryVisionModel"), ...validation.fields.vision_model },
      { key: "embedding", label: t("embeddingTitle"), ...validation.fields.embedding },
      { key: "rerank", label: t("rerankTitle"), ...validation.fields.rerank },
    ]
  }

  const overallTone = (): StatusTone => {
    if (liveValidation().status === "passed") return "success"
    if (liveValidation().status === "failed" || staticValidation().status === "failed") return "critical"
    return "pending"
  }

  const overallTitle = () => {
    if (liveValidation().status === "passed") return t("importValidated")
    if (staticValidation().status === "failed" || liveValidation().status === "failed") return t("importInvalid")
    return t("importValidationRunning")
  }

  const statusPillTone = (status: string): StatusTone => {
    if (status === "passed") return "success"
    if (status === "failed") return "critical"
    if (status === "running") return "info"
    return "pending"
  }

  const statusPillLabel = (status: string) => {
    if (status === "running") return t("importValidationRunningShort")
    if (status === "passed") return t("coreValidationPassed")
    if (status === "failed") return t("coreValidationFailed")
    return t("coreValidationPending")
  }

  const fieldTone = (fieldValid: boolean): StatusTone => {
    if (liveValidation().status !== "passed" && liveValidation().status !== "failed") return "pending"
    return fieldValid ? "success" : "critical"
  }

  return (
    <div class="flex flex-col gap-6">
      <section class="su-import-shell">
        <div class="su-import-header">
          <div>
            <div class="su-section-label">{t("importEditorEyebrow")}</div>
            <h2 class="su-required-title">{t("importEditorTitle")}</h2>
            <p class="su-required-copy">{t("importEditorDescription")}</p>
          </div>
          <div class="su-import-actions">
            <input
              ref={(element) => (fileInputRef = element)}
              type="file"
              accept=".json,.jsonc"
              class="hidden"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0]
                if (file) handleFile(file)
              }}
            />
            <Button variant="secondary" size="large" icon="download" onClick={() => fileInputRef?.click()}>
              {t("uploadFile")}
            </Button>
          </div>
        </div>

        <CodePanel>
          <TextField
            multiline
            class="su-code-editor font-mono"
            placeholder={t("importEditorPlaceholder")}
            value={importedConfigText()}
            onChange={resetValidationState}
          />
        </CodePanel>

        <div class="su-import-footer">
          <div class="su-import-footer-copy">{t("importActionHint")}</div>
          <Button
            variant="primary"
            size="large"
            disabled={!importedConfigText().trim() || validating()}
            onClick={handleValidate}
          >
            {validating() ? t("importValidationRunning") : t("importValidateAction")}
          </Button>
        </div>
      </section>

      <Show when={staticValidation().error}>
        <InlineAlert variant="error">{staticValidation().error}</InlineAlert>
      </Show>

      <Show when={liveValidation().error}>
        <InlineAlert variant="error">{liveValidation().error}</InlineAlert>
      </Show>

      <Show when={hasResult()}>
        <section class="su-import-results">
          <div class="su-import-results-header">
            <div>
              <div class="su-section-label">{t("importResultsTitle")}</div>
              <h2 class="su-required-title">{overallTitle()}</h2>
              <p class="su-required-copy">{t("importResultsDescription")}</p>
            </div>
            <div class="su-status-grid">
              <div class="su-status-card">
                <div class="su-section-label">{t("importStaticValidationTitle")}</div>
                <StatusPill tone={statusPillTone(staticValidation().status)}>
                  {statusPillLabel(staticValidation().status)}
                </StatusPill>
              </div>
              <div class="su-status-card">
                <div class="su-section-label">{t("importLiveValidationTitle")}</div>
                <StatusPill tone={statusPillTone(liveValidation().status)}>
                  {statusPillLabel(liveValidation().status)}
                </StatusPill>
              </div>
            </div>
          </div>

          <div>
            <div class="su-section-label">{t("importRequiredModels")}</div>
            <div class="su-validation-grid mt-3">
              <For each={coreFieldEntries()}>
                {(field) => (
                  <ValidationCard
                    tone={
                      liveValidation().status === "passed" || liveValidation().status === "failed"
                        ? fieldTone(field.valid)
                        : undefined
                    }
                  >
                    <div class="flex items-center justify-between gap-3">
                      <span class="su-validation-field-label">{field.label}</span>
                      <StatusPill tone={fieldTone(field.valid)}>
                        {liveValidation().status === "passed" || liveValidation().status === "failed"
                          ? field.valid
                            ? t("coreValidationPassed")
                            : t("coreValidationFailed")
                          : t("coreValidationPending")}
                      </StatusPill>
                    </div>
                    <p class="su-validation-field-message break-words">
                      {liveValidation().status === "passed" || liveValidation().status === "failed"
                        ? field.message || t("coreValidationAwaiting")
                        : t("importLiveValidationAwaiting")}
                    </p>
                  </ValidationCard>
                )}
              </For>
            </div>
          </div>
        </section>
      </Show>
    </div>
  )
}
