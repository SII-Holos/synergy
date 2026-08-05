import { createMemo, createSignal, For, Show, onCleanup, onMount } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLocale } from "@/context/locale"
import { requestErrorMessage } from "@/utils/error"
import { SettingsPage, SettingsSection, SettingsSubsection } from "../components/SettingsPrimitives"
import { formatBytes, jobPercent, jobSummary } from "./session-import-model"
import type {
  ForeignImportCandidate,
  ForeignImportJobState,
  ForeignImportSingleResult,
  ForeignImportSource,
} from "@ericsanchezok/synergy-sdk/client"
/* ── Copy ──────────────────────────────────────────────────────────────── */

const pageTitle = { id: "settings.sessionImport.page.title", message: "Session Import" }
const pageDescription = {
  id: "settings.sessionImport.page.description",
  message: "Import past sessions from Claude Code or Codex transcripts into Synergy.",
}
const uploadSectionTitle = { id: "settings.sessionImport.upload.title", message: "Upload transcript" }
const uploadSectionDesc = {
  id: "settings.sessionImport.upload.desc",
  message: "Pick a single Claude Code or Codex jsonl transcript file to import.",
}
const scanSectionTitle = { id: "settings.sessionImport.scan.title", message: "Scan local transcripts" }
const scanSectionDesc = {
  id: "settings.sessionImport.scan.desc",
  message: "Scan the default transcript directories on this computer and import selected sessions.",
}
const sourceLabel = { id: "settings.sessionImport.source", message: "Source" }
const claudeLabel = { id: "settings.sessionImport.source.claude", message: "Claude Code" }
const codexLabel = { id: "settings.sessionImport.source.codex", message: "Codex" }
const chooseFileLabel = { id: "settings.sessionImport.chooseFile", message: "Choose jsonl file" }
const importFileLabel = { id: "settings.sessionImport.importFile", message: "Import file" }
const importingFileLabel = { id: "settings.sessionImport.importingFile", message: "Importing..." }
const scanLabel = { id: "settings.sessionImport.scan", message: "Scan" }
const scanningLabel = { id: "settings.sessionImport.scanning", message: "Scanning..." }
const noCandidates = { id: "settings.sessionImport.noCandidates", message: "No transcripts found." }
const selectAllLabel = { id: "settings.sessionImport.selectAll", message: "Select all" }
const importSelectedLabel = { id: "settings.sessionImport.importSelected", message: "Import selected" }
const importingSelectedLabel = { id: "settings.sessionImport.importingSelected", message: "Importing..." }
const cancelJobLabel = { id: "settings.sessionImport.cancelJob", message: "Cancel" }
const cancellingJobLabel = { id: "settings.sessionImport.cancellingJob", message: "Cancelling..." }
const importCompleteTitle = { id: "settings.sessionImport.complete", message: "Session import complete" }
const importFailedTitle = { id: "settings.sessionImport.failed", message: "Session import failed" }
const jobFailedTitle = { id: "settings.sessionImport.jobFailed", message: "Import job failed" }
const untitledSession = { id: "settings.sessionImport.untitled", message: "Untitled session" }
const includeThinkingLabel = {
  id: "settings.sessionImport.includeThinking",
  message: "Include thinking blocks",
}
const importHint = {
  id: "settings.sessionImport.hint",
  message:
    "Imported sessions are created in the scope for the transcript's original working directory (created when missing), or the current scope when that directory is unavailable. Failed imports are rolled back automatically.",
}

function candidatesFoundDesc(count: number) {
  return { id: "settings.sessionImport.candidatesFound.desc", message: "{count} transcripts", values: { count } }
}

function sourceLabelText(source: ForeignImportSource): string {
  return source === "claude-code" ? "Claude Code" : "Codex"
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timeout)
      reject(new DOMException("Aborted", "AbortError"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/* ── Panel ─────────────────────────────────────────────────────────────── */

export function SessionImportPanel() {
  const { _ } = useLingui()
  const { fmt } = useLocale()
  const globalSDK = useGlobalSDK()

  const [uploadSource, setUploadSource] = createSignal<ForeignImportSource>("claude-code")
  const [file, setFile] = createSignal<File>()
  const [importingFile, setImportingFile] = createSignal(false)
  const [includeThinking, setIncludeThinking] = createSignal(false)

  const [scanSource, setScanSource] = createSignal<ForeignImportSource>("claude-code")
  const [scanning, setScanning] = createSignal(false)
  const [candidates, setCandidates] = createSignal<ForeignImportCandidate[]>([])
  const [selected, setSelected] = createSignal<Set<string>>(new Set())
  const [rootDir, setRootDir] = createSignal("")
  const [job, setJob] = createSignal<ForeignImportJobState>()
  const [cancelling, setCancelling] = createSignal(false)

  let observer: AbortController | undefined

  onCleanup(() => observer?.abort())

  onMount(() => {
    void (async () => {
      try {
        const response = await globalSDK.client.session.getForeignImportJob()
        if (response.error || !response.data) return
        const current = response.data
        setJob(current)
        if (current.status === "running") observeJob(current)
      } catch {
        // no job yet — fine
      }
    })()
  })

  function observeJob(initial: ForeignImportJobState) {
    observer?.abort()
    const controller = new AbortController()
    observer = controller
    setJob(initial)
    void (async () => {
      while (!controller.signal.aborted) {
        try {
          await wait(500, controller.signal)
        } catch {
          return
        }
        if (controller.signal.aborted) return
        try {
          const response = await globalSDK.client.session.getForeignImportJob()
          if (controller.signal.aborted) return
          if (response.error || !response.data) {
            setJob((current) => (current ? { ...current, status: "completed" } : current))
            return
          }
          const next = response.data
          setJob(next)
          if (next.status !== "running") return
        } catch {
          return
        }
      }
    })()
  }

  async function handleFileImport() {
    const selectedFile = file()
    if (!selectedFile) return
    setImportingFile(true)
    try {
      const response = await globalSDK.client.session.importForeign({
        source: uploadSource(),
        file: selectedFile,
        includeThinking: includeThinking() ? "true" : "false",
      })
      if (response.error) throw response.error
      const result = response.data as ForeignImportSingleResult | undefined
      if (!result) throw new Error("No import result returned")
      showToast({
        type: "success",
        title: _(importCompleteTitle),
        description: `${result.sessionCount} session(s), ${result.messageCount} message(s)`,
      })
      setFile(undefined)
    } catch (error) {
      showToast({ type: "error", title: _(importFailedTitle), description: requestErrorMessage(error) })
    } finally {
      setImportingFile(false)
    }
  }

  async function handleScan() {
    setScanning(true)
    setCandidates([])
    setSelected(new Set<string>())
    setRootDir("")
    try {
      const response = await globalSDK.client.session.scanForeign({ source: scanSource() })
      if (response.error) throw response.error
      const result = response.data
      if (!result) throw new Error("No scan result returned")
      setCandidates(result.candidates)
      setRootDir(result.root)
      setSelected(new Set(result.candidates.map((candidate) => candidate.path)))
    } catch (error) {
      showToast({ type: "error", title: _(importFailedTitle), description: requestErrorMessage(error) })
    } finally {
      setScanning(false)
    }
  }

  function toggleCandidate(path: string, enabled: boolean) {
    setSelected((previous) => {
      const next = new Set(previous)
      if (enabled) next.add(path)
      else next.delete(path)
      return next
    })
  }

  function toggleAll(enabled: boolean) {
    setSelected(new Set<string>(enabled ? candidates().map((candidate) => candidate.path) : []))
  }

  async function handleBatchImport() {
    const paths = [...selected()]
    if (paths.length === 0) return
    try {
      const response = await globalSDK.client.session.startForeignImportJob({
        foreignImportJobInput: {
          source: scanSource(),
          paths,
          includeThinking: includeThinking() || undefined,
        },
      })
      if (response.error) {
        const conflict = response.error as { job?: ForeignImportJobState }
        if (conflict?.job && conflict.job.status === "running") {
          observeJob(conflict.job)
          return
        }
        throw response.error
      }
      const summary = response.data
      if (!summary) throw new Error("No job returned")
      const initial: ForeignImportJobState = {
        ...summary,
        items: paths.map((path) => ({ path, status: "pending" as const })),
      }
      setJob(initial)
      observeJob(initial)
    } catch (error) {
      showToast({ type: "error", title: _(importFailedTitle), description: requestErrorMessage(error) })
    }
  }

  async function handleCancel() {
    const current = job()
    if (!current || current.status !== "running" || cancelling()) return
    setCancelling(true)
    try {
      const response = await globalSDK.client.session.cancelForeignImportJob()
      if (response.error) throw response.error
      observer?.abort()
      setJob(response.data)
    } catch (error) {
      showToast({ type: "error", title: _(jobFailedTitle), description: requestErrorMessage(error) })
    } finally {
      setCancelling(false)
    }
  }

  const runningJob = createMemo(() => (job()?.status === "running" ? job() : undefined))
  const selectedCount = createMemo(() => selected().size)
  const allSelected = createMemo(() => candidates().length > 0 && selected().size === candidates().length)
  const doneJob = createMemo(() => (job() && job()!.status !== "running" ? job() : undefined))

  return (
    <SettingsPage title={_(pageTitle)} description={_(pageDescription)}>
      <SettingsSection title={_(uploadSectionTitle)} description={_(uploadSectionDesc)}>
        <div class="ds-import-source-row">
          <label class="ds-import-field">
            <span>{_(sourceLabel)}</span>
            <select
              class="settings-select"
              value={uploadSource()}
              onChange={(event) => setUploadSource(event.currentTarget.value as ForeignImportSource)}
            >
              <option value="claude-code">{_(claudeLabel)}</option>
              <option value="codex">{_(codexLabel)}</option>
            </select>
          </label>
          <label class="ds-import-file-button">
            <Icon name={getSemanticIcon("action.import")} size="small" />
            {file() ? file()!.name : _(chooseFileLabel)}
            <input
              type="file"
              accept=".jsonl,application/x-ndjson"
              onChange={(event) => setFile(event.currentTarget.files?.[0])}
            />
          </label>
          <Button
            variant="primary"
            size="normal"
            disabled={!file() || importingFile() || runningJob() !== undefined}
            onClick={() => void handleFileImport()}
          >
            {importingFile() ? _(importingFileLabel) : _(importFileLabel)}
          </Button>
        </div>
        <label class="ds-import-checkbox-row">
          <input
            type="checkbox"
            checked={includeThinking()}
            onChange={(event) => setIncludeThinking(event.currentTarget.checked)}
          />
          <span>{_(includeThinkingLabel)}</span>
        </label>
        <div class="ds-import-hint">{_(importHint)}</div>
      </SettingsSection>

      <SettingsSection title={_(scanSectionTitle)} description={_(scanSectionDesc)}>
        <div class="ds-import-source-row">
          <label class="ds-import-field">
            <span>{_(sourceLabel)}</span>
            <select
              class="settings-select"
              value={scanSource()}
              onChange={(event) => {
                setScanSource(event.currentTarget.value as ForeignImportSource)
                setCandidates([])
                setSelected(new Set<string>())
              }}
            >
              <option value="claude-code">{_(claudeLabel)}</option>
              <option value="codex">{_(codexLabel)}</option>
            </select>
          </label>
          <Button
            variant={candidates().length === 0 ? "primary" : "secondary"}
            size="normal"
            icon={getSemanticIcon(scanning() ? "action.refresh" : "action.search")}
            disabled={scanning() || runningJob() !== undefined}
            onClick={() => void handleScan()}
          >
            {scanning() ? _(scanningLabel) : _(scanLabel)}
          </Button>
        </div>

        <Show when={rootDir() && candidates().length === 0 && !scanning()}>
          <div class="ds-import-hint">{rootDir()}</div>
        </Show>

        <Show when={candidates().length > 0}>
          <div class="ds-import-plan-header">
            <div>
              <div class="settings-import-source-title">{sourceLabelText(scanSource())}</div>
              <div class="settings-import-source-meta">
                {_(candidatesFoundDesc(candidates().length))} · {rootDir()}
              </div>
            </div>
            <div class="ds-import-scan-actions">
              <Button variant="ghost" size="small" onClick={() => toggleAll(!allSelected())}>
                {_(selectAllLabel)}
              </Button>
              <Button
                variant="primary"
                size="small"
                disabled={selectedCount() === 0 || runningJob() !== undefined}
                onClick={() => void handleBatchImport()}
              >
                {_(importSelectedLabel)}
              </Button>
            </div>
          </div>
          <div class="ds-import-domain-grid">
            <For each={candidates()}>
              {(candidate) => (
                <label class="ds-import-domain-toggle">
                  <input
                    type="checkbox"
                    checked={selected().has(candidate.path)}
                    disabled={runningJob() !== undefined}
                    onChange={(event) => toggleCandidate(candidate.path, event.currentTarget.checked)}
                  />
                  <span class="ds-import-candidate-title">{candidate.title || _(untitledSession)}</span>
                  <span class="ds-import-candidate-meta">
                    {fmt.date(candidate.updated)} · {formatBytes(candidate.sizeBytes)}
                  </span>
                </label>
              )}
            </For>
          </div>
        </Show>

        <Show when={!scanning() && candidates().length === 0 && rootDir()}>
          <div class="ds-import-hint">{_(noCandidates)}</div>
        </Show>

        <Show when={runningJob()}>
          {(current) => (
            <SettingsSubsection title={_(importingSelectedLabel)}>
              <div
                class="usage-window-meter"
                style="margin-bottom: 8px;"
                role="progressbar"
                aria-label={_(importingSelectedLabel)}
                aria-valuemin="0"
                aria-valuemax={current().totalCount}
                aria-valuenow={current().completedCount}
              >
                <span style={`width: ${jobPercent(current())}%`} />
              </div>
              <div style="display:flex; justify-content:space-between; align-items:center;">
                <div style="gap:12px; display:flex;">
                  <span class="usage-overview-label">
                    {current().completedCount} / {current().totalCount}
                  </span>
                  <span class="usage-overview-label">{jobSummary(current())}</span>
                </div>
                <Button variant="ghost" size="small" disabled={cancelling()} onClick={() => void handleCancel()}>
                  {cancelling() ? _(cancellingJobLabel) : _(cancelJobLabel)}
                </Button>
              </div>
            </SettingsSubsection>
          )}
        </Show>

        <Show when={doneJob()}>
          {(done) => (
            <div class="ds-setting-subsection" style="color: var(--text-weak);">
              <span>{jobSummary(done())}</span>
            </div>
          )}
        </Show>
      </SettingsSection>
    </SettingsPage>
  )
}
