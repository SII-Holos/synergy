import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import type { MessageDescriptor } from "@lingui/core"
import { useLingui } from "@lingui/solid"
import type { EmbeddingStatus } from "@ericsanchezok/synergy-sdk/client"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLocale, type IntlFormatter } from "@/context/locale"
import { SettingRow } from "../components/SettingRow"
import { SettingsSection } from "../components/SettingsPrimitives"
import type { LibrarySettingsStore, LocalEmbeddingSource } from "../types"
import { describeEmbeddingModel, isEmbeddingDownloadActive, pollEmbeddingStatus } from "./library-embedding-model"

/* ---------- static descriptors ---------- */

const sectionTitle = {
  id: "settings.library.embedding.section.title",
  message: "Embedding model",
}
const sectionDesc = {
  id: "settings.library.embedding.section.desc",
  message: "See the active embedding model and manage downloads for the built-in local fallback.",
}

const loadingLabel = {
  id: "settings.library.embedding.loading",
  message: "Checking embedding configuration\u2026",
}

const currentModelTitle = {
  id: "settings.library.embedding.currentModel.title",
  message: "Current model",
}

const remoteFallbackRowTitle = {
  id: "settings.library.embedding.remoteFallback.title",
  message: "Local model download",
}
const remoteFallbackRowDesc = {
  id: "settings.library.embedding.remoteFallback.desc",
  message: "The user-configured remote model takes precedence, so the built-in local fallback is not used.",
}
const remoteFallbackInactive = {
  id: "settings.library.embedding.remoteFallback.inactive",
  message: "Inactive",
}
const remoteFallbackNoDownload = {
  id: "settings.library.embedding.remoteFallback.noDownload",
  message: "No download needed",
}

const downloadSourceTitle = {
  id: "settings.library.embedding.downloadSource.title",
  message: "Download source",
}
const downloadSourceDesc = {
  id: "settings.library.embedding.downloadSource.desc",
  message: "Choose where Synergy downloads the bundled local model. Save source changes before downloading.",
}
const downloadSourceAria = {
  id: "settings.library.embedding.downloadSource.aria",
  message: "Local embedding download source",
}

const customOriginOption = {
  id: "settings.library.embedding.source.option.custom",
  message: "Custom origin",
}

const customSourceTitle = {
  id: "settings.library.embedding.customSource.title",
  message: "Custom source origin",
}
const customSourceDesc = {
  id: "settings.library.embedding.customSource.desc",
  message: "Use a public HTTPS origin without credentials, a path, query, or fragment.",
}
const customSourceLabel = {
  id: "settings.library.embedding.customSource.label",
  message: "Custom embedding source origin",
}
const customSourceInvalid = {
  id: "settings.library.embedding.customSource.invalid",
  message: "Origin is required for a custom source.",
}

const localFilesTitle = {
  id: "settings.library.embedding.localFiles.title",
  message: "Local model files",
}
const localFilesSaveFirst = {
  id: "settings.library.embedding.localFiles.saveFirst",
  message: "Save the selected source before starting the download.",
}

const stateReady = { id: "settings.library.embedding.state.ready", message: "Ready" }
const stateDownloading = { id: "settings.library.embedding.state.downloading", message: "Downloading" }
const stateFailed = { id: "settings.library.embedding.state.failed", message: "Failed" }
const stateMissing = { id: "settings.library.embedding.state.missing", message: "Missing" }

const buttonStarting = { id: "settings.library.embedding.button.starting", message: "Starting\u2026" }
const buttonRetry = { id: "settings.library.embedding.button.retry", message: "Retry" }
const buttonDownloaded = { id: "settings.library.embedding.button.downloaded", message: "Downloaded" }
const buttonDownloading = { id: "settings.library.embedding.button.downloading", message: "Downloading\u2026" }
const buttonDownload = { id: "settings.library.embedding.button.download", message: "Download" }

const progressAria = {
  id: "settings.library.embedding.progress.aria",
  message: "Local embedding model download",
}

/* ---------- local-status descriptors ---------- */

const localCachedDesc = {
  id: "settings.library.embedding.localStatus.cached",
  message: "Model files are ready",
}
const localDownloadingFallbackDesc = {
  id: "settings.library.embedding.localStatus.downloading",
  message: "Downloading local model files",
}
const localFailedDesc = {
  id: "settings.library.embedding.localStatus.failed",
  message: "The last download failed",
}
const localMissingDesc = {
  id: "settings.library.embedding.localStatus.missing",
  message: "Model files are not downloaded",
}

/* ---------- toast descriptors ---------- */

const statusUnavailableTitle = {
  id: "settings.library.embedding.toast.statusUnavailable",
  message: "Embedding status unavailable",
}
const statusLoadFallback = {
  id: "settings.library.embedding.toast.statusLoadFallback",
  message: "The local model state could not be loaded.",
}
const statusObserverFallback = {
  id: "settings.library.embedding.toast.statusObserverFallback",
  message: "The download may still be running.",
}

const downloadStartErrorTitle = {
  id: "settings.library.embedding.toast.downloadStartError",
  message: "Embedding download could not start",
}
const downloadStartFallback = {
  id: "settings.library.embedding.toast.downloadStartFallback",
  message: "Check the configured download source and try again.",
}

/* ---------- Synergy-authored error fallbacks ---------- */

const statusUnavailableError = {
  id: "settings.library.embedding.error.statusUnavailable",
  message: "Embedding status is unavailable",
}
const downloadStartError = {
  id: "settings.library.embedding.error.downloadStart",
  message: "The download could not be started",
}

/* ---------- helpers ---------- */

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message
  }
  return fallback
}

function formatBytes(value: number, fmt: IntlFormatter): string {
  if (value < 1024) return `${fmt.number(value)} B`
  const units = ["KB", "MB", "GB"]
  let size = value / 1024
  let unit = units[0]
  for (let index = 1; index < units.length && size >= 1024; index++) {
    size /= 1024
    unit = units[index]
  }
  const fractionDigits = size >= 10 ? 0 : 1
  return `${fmt.number(size, { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits })} ${unit}`
}

function localStatusDescription(
  status: Extract<EmbeddingStatus, { mode: "local" }>,
  fmt: IntlFormatter,
): MessageDescriptor {
  if (status.asset === "cached") return localCachedDesc
  if (status.asset === "downloading") {
    const progress = status.progress
    if (progress?.totalBytes) {
      return {
        id: "settings.library.embedding.localStatus.downloadProgress",
        message: "Downloading {loaded} of {total}",
        values: {
          loaded: formatBytes(progress.loadedBytes, fmt),
          total: formatBytes(progress.totalBytes, fmt),
        },
      }
    }
    return localDownloadingFallbackDesc
  }
  if (status.asset === "failed") return localFailedDesc
  return localMissingDesc
}

/* ---------- component ---------- */

export function LibraryEmbeddingSection(props: {
  library: LibrarySettingsStore
  configDirty: boolean
  onLibraryChange: (key: keyof LibrarySettingsStore, value: string) => void
}) {
  const globalSDK = useGlobalSDK()
  const { _ } = useLingui()
  const { fmt } = useLocale()
  const [status, setStatus] = createSignal<EmbeddingStatus>()
  const [loading, setLoading] = createSignal(true)
  const [starting, setStarting] = createSignal(false)
  let observer: AbortController | undefined
  let disposed = false

  const localStatus = createMemo(() => {
    const current = status()
    return current?.mode === "local" ? current : undefined
  })
  const modelPresentation = createMemo(() => {
    const current = status()
    return current ? describeEmbeddingModel(current) : undefined
  })
  const modelDesc = createMemo(() => {
    const model = modelPresentation()
    return model ? _(model.description) : ""
  })
  const modelStateLabel = createMemo(() => {
    const model = modelPresentation()
    return model ? _(model.stateLabel) : ""
  })
  const modelModeLabel = createMemo(() => {
    const model = modelPresentation()
    return model ? _(model.modeLabel) : ""
  })
  const customSourceMissing = createMemo(
    () => props.library.embeddingSource === "custom" && !props.library.embeddingRemoteHost.trim(),
  )
  const downloadDisabled = createMemo(() => {
    const current = localStatus()
    return (
      loading() ||
      starting() ||
      props.configDirty ||
      customSourceMissing() ||
      current?.asset === "downloading" ||
      current?.asset === "cached"
    )
  })

  async function loadStatus(): Promise<EmbeddingStatus> {
    const response = await globalSDK.client.library.embedding.status()
    if (!response.data) throw response.error ?? new Error(_(statusUnavailableError))
    return response.data
  }

  function observeDownload(initial: EmbeddingStatus) {
    observer?.abort()
    const controller = new AbortController()
    observer = controller
    setStatus(initial)
    void pollEmbeddingStatus({
      load: loadStatus,
      onUpdate: setStatus,
      signal: controller.signal,
    })
      .catch((error) => {
        if (controller.signal.aborted || disposed) return
        showToast({
          type: "error",
          title: _(statusUnavailableTitle),
          description: errorMessage(error, _(statusObserverFallback)),
        })
      })
      .finally(() => {
        if (observer === controller) observer = undefined
      })
  }

  onMount(() => {
    void loadStatus()
      .then((current) => {
        if (disposed) return
        setStatus(current)
        if (isEmbeddingDownloadActive(current)) observeDownload(current)
      })
      .catch((error) => {
        if (disposed) return
        showToast({
          type: "error",
          title: _(statusUnavailableTitle),
          description: errorMessage(error, _(statusLoadFallback)),
        })
      })
      .finally(() => {
        if (!disposed) setLoading(false)
      })
  })

  onCleanup(() => {
    disposed = true
    observer?.abort()
  })

  async function startDownload() {
    if (downloadDisabled()) return
    setStarting(true)
    try {
      const response = await globalSDK.client.library.embedding.download()
      if (!response.data) throw response.error ?? new Error(_(downloadStartError))
      setStatus(response.data)
      if (isEmbeddingDownloadActive(response.data)) observeDownload(response.data)
    } catch (error) {
      showToast({
        type: "error",
        title: _(downloadStartErrorTitle),
        description: errorMessage(error, _(downloadStartFallback)),
      })
    } finally {
      setStarting(false)
    }
  }

  function buttonLabel(): string {
    if (starting()) return _(buttonStarting)
    const current = localStatus()
    if (current?.asset === "failed") return _(buttonRetry)
    if (current?.asset === "cached") return _(buttonDownloaded)
    if (current?.asset === "downloading") return _(buttonDownloading)
    return _(buttonDownload)
  }

  function stateLabelText(): string {
    const current = localStatus()
    if (current?.asset === "cached") return _(stateReady)
    if (current?.asset === "downloading") return _(stateDownloading)
    if (current?.asset === "failed") return _(stateFailed)
    return _(stateMissing)
  }

  function localStatusText(current: Extract<EmbeddingStatus, { mode: "local" }>): string {
    if (current.asset === "failed" && current.error?.message) return current.error.message
    return _(localStatusDescription(current, fmt))
  }

  return (
    <SettingsSection title={_(sectionTitle)} description={_(sectionDesc)}>
      <Show
        when={!loading()}
        fallback={
          <div class="settings-embedding-loading">
            <Spinner class="size-4" />
            <span>{_(loadingLabel)}</span>
          </div>
        }
      >
        <Show when={modelPresentation()}>
          {(model) => (
            <SettingRow
              title={_(currentModelTitle)}
              description={`${model().title} \u00b7 ${modelDesc()}`}
              stateLabel={modelStateLabel()}
              trailing={<span class="settings-row-state">{modelModeLabel()}</span>}
            />
          )}
        </Show>
        <Show
          when={status()?.mode !== "remote"}
          fallback={
            <SettingRow
              title={_(remoteFallbackRowTitle)}
              description={_(remoteFallbackRowDesc)}
              stateLabel={_(remoteFallbackInactive)}
              trailing={<span class="settings-row-state">{_(remoteFallbackNoDownload)}</span>}
            />
          }
        >
          <SettingRow
            title={_(downloadSourceTitle)}
            description={_(downloadSourceDesc)}
            trailing={
              <select
                class="settings-select"
                aria-label={_(downloadSourceAria)}
                value={props.library.embeddingSource}
                onChange={(event) =>
                  props.onLibraryChange("embeddingSource", event.currentTarget.value as LocalEmbeddingSource)
                }
              >
                <option value="huggingface">Hugging Face</option>
                <option value="hf-mirror">HF Mirror</option>
                <option value="custom">{_(customOriginOption)}</option>
              </select>
            }
          />
          <Show when={props.library.embeddingSource === "custom"}>
            <SettingRow
              title={_(customSourceTitle)}
              description={_(customSourceDesc)}
              trailing={
                <div class="settings-embedding-host">
                  <TextField
                    type="url"
                    label={_(customSourceLabel)}
                    hideLabel
                    required
                    placeholder="https://models.example"
                    value={props.library.embeddingRemoteHost}
                    validationState={customSourceMissing() ? "invalid" : "valid"}
                    error={customSourceMissing() ? _(customSourceInvalid) : undefined}
                    onChange={(value) => props.onLibraryChange("embeddingRemoteHost", value)}
                  />
                </div>
              }
            />
          </Show>
          <Show when={localStatus()}>
            {(current) => (
              <>
                <SettingRow
                  title={_(localFilesTitle)}
                  description={props.configDirty ? _(localFilesSaveFirst) : localStatusText(current())}
                  stateLabel={stateLabelText()}
                  trailing={
                    <Button
                      type="button"
                      variant={current().asset === "failed" ? "secondary" : "primary"}
                      size="small"
                      icon={getSemanticIcon("action.download")}
                      disabled={downloadDisabled()}
                      onClick={() => void startDownload()}
                    >
                      {buttonLabel()}
                    </Button>
                  }
                />
                <Show when={current().asset === "downloading"}>
                  <div class="settings-embedding-progress">
                    <div
                      class="usage-window-meter"
                      role="progressbar"
                      aria-label={_(progressAria)}
                      aria-valuemin="0"
                      aria-valuemax="100"
                      aria-valuenow={current().progress?.percent ?? 0}
                    >
                      <span style={{ width: `${current().progress?.percent ?? 0}%` }} />
                    </div>
                    <span class="usage-overview-label">
                      {fmt.percent((current().progress?.percent ?? 0) / 100, { maximumFractionDigits: 0 })}
                    </span>
                  </div>
                </Show>
              </>
            )}
          </Show>
        </Show>
      </Show>
    </SettingsSection>
  )
}
