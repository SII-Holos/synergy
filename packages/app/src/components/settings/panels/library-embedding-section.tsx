import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import type { EmbeddingStatus } from "@ericsanchezok/synergy-sdk/client"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { useGlobalSDK } from "@/context/global-sdk"
import { SettingRow } from "../components/SettingRow"
import { SettingsSection } from "../components/SettingsPrimitives"
import type { LibrarySettingsStore, LocalEmbeddingSource } from "../types"
import { isEmbeddingDownloadActive, pollEmbeddingStatus } from "./library-embedding-model"

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message
  }
  return fallback
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  const units = ["KB", "MB", "GB"]
  let size = value / 1024
  let unit = units[0]
  for (let index = 1; index < units.length && size >= 1024; index++) {
    size /= 1024
    unit = units[index]
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${unit}`
}

function localStatusDescription(status: Extract<EmbeddingStatus, { mode: "local" }>): string {
  if (status.asset === "cached") return `Ready · ${status.model}`
  if (status.asset === "downloading") {
    const progress = status.progress
    if (progress?.totalBytes) {
      return `Downloading ${formatBytes(progress.loadedBytes)} of ${formatBytes(progress.totalBytes)}`
    }
    return "Downloading local model files"
  }
  if (status.asset === "failed") return status.error?.message ?? "The last download failed"
  return `Not downloaded · ${status.model}`
}

export function LibraryEmbeddingSection(props: {
  library: LibrarySettingsStore
  configDirty: boolean
  onLibraryChange: (key: keyof LibrarySettingsStore, value: string) => void
}) {
  const globalSDK = useGlobalSDK()
  const [status, setStatus] = createSignal<EmbeddingStatus>()
  const [loading, setLoading] = createSignal(true)
  const [starting, setStarting] = createSignal(false)
  let observer: AbortController | undefined
  let disposed = false

  const localStatus = createMemo(() => {
    const current = status()
    return current?.mode === "local" ? current : undefined
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
    if (!response.data) throw response.error ?? new Error("Embedding status is unavailable")
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
          title: "Embedding status unavailable",
          description: errorMessage(error, "The download may still be running."),
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
          title: "Embedding status unavailable",
          description: errorMessage(error, "The local model state could not be loaded."),
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
      if (!response.data) throw response.error ?? new Error("The download could not be started")
      setStatus(response.data)
      if (isEmbeddingDownloadActive(response.data)) observeDownload(response.data)
    } catch (error) {
      showToast({
        type: "error",
        title: "Embedding download could not start",
        description: errorMessage(error, "Check the configured download source and try again."),
      })
    } finally {
      setStarting(false)
    }
  }

  return (
    <SettingsSection
      title="Embedding model"
      description="Manage the bundled local model used to match memory and experience context."
    >
      <Show
        when={!loading()}
        fallback={
          <div class="settings-embedding-loading">
            <Spinner class="size-4" />
            <span>Checking embedding configuration…</span>
          </div>
        }
      >
        <Show
          when={status()?.mode !== "remote"}
          fallback={
            <SettingRow
              title="Remote embedding service"
              description={`Local model controls are unavailable while ${status()?.model ?? "a remote model"} is configured.`}
              stateLabel="Remote"
              trailing={<span class="settings-row-state">No download needed</span>}
            />
          }
        >
          <SettingRow
            title="Download source"
            description="Choose where Synergy downloads the bundled local model. Save source changes before downloading."
            trailing={
              <select
                class="settings-select"
                aria-label="Local embedding download source"
                value={props.library.embeddingSource}
                onChange={(event) =>
                  props.onLibraryChange("embeddingSource", event.currentTarget.value as LocalEmbeddingSource)
                }
              >
                <option value="huggingface">Hugging Face</option>
                <option value="hf-mirror">HF Mirror</option>
                <option value="custom">Custom origin</option>
              </select>
            }
          />
          <Show when={props.library.embeddingSource === "custom"}>
            <SettingRow
              title="Custom source origin"
              description="Use a public HTTPS origin without credentials, a path, query, or fragment."
              trailing={
                <div class="settings-embedding-host">
                  <TextField
                    type="url"
                    label="Custom embedding source origin"
                    hideLabel
                    required
                    placeholder="https://models.example"
                    value={props.library.embeddingRemoteHost}
                    validationState={customSourceMissing() ? "invalid" : "valid"}
                    error={customSourceMissing() ? "Origin is required for a custom source." : undefined}
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
                  title="Local model"
                  description={
                    props.configDirty
                      ? "Save the selected source before starting the download."
                      : localStatusDescription(current())
                  }
                  stateLabel={
                    current().asset === "cached"
                      ? "Ready"
                      : current().asset === "downloading"
                        ? "Downloading"
                        : current().asset === "failed"
                          ? "Failed"
                          : "Missing"
                  }
                  trailing={
                    <Button
                      type="button"
                      variant={current().asset === "failed" ? "secondary" : "primary"}
                      size="small"
                      icon={getSemanticIcon("action.download")}
                      disabled={downloadDisabled()}
                      onClick={() => void startDownload()}
                    >
                      {starting()
                        ? "Starting…"
                        : current().asset === "failed"
                          ? "Retry"
                          : current().asset === "cached"
                            ? "Downloaded"
                            : current().asset === "downloading"
                              ? "Downloading…"
                              : "Download"}
                    </Button>
                  }
                />
                <Show when={current().asset === "downloading"}>
                  <div class="settings-embedding-progress">
                    <div
                      class="usage-window-meter"
                      role="progressbar"
                      aria-label="Local embedding model download"
                      aria-valuemin="0"
                      aria-valuemax="100"
                      aria-valuenow={current().progress?.percent ?? 0}
                    >
                      <span style={{ width: `${current().progress?.percent ?? 0}%` }} />
                    </div>
                    <span class="usage-overview-label">{Math.round(current().progress?.percent ?? 0)}%</span>
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
