import { useConfirm } from "@/components/dialog/confirm-dialog"
import { cancelReencodeConfirm, reencodeExperienceConfirm } from "@/components/dialog/confirm-copy"

import { useLingui } from "@lingui/solid"
import { useLocale } from "@/context/locale"
import { createSignal, Show, For, createMemo, onCleanup, onMount } from "solid-js"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { SettingsSubsection } from "../components/SettingsPrimitives"
import { SettingsStepScale } from "../components/SettingsStepScale"
import type { SettingsStepOption } from "../components/SettingsStepScale"
import { SettingsPage, SettingsSection } from "../components/SettingsPrimitives"
import { SettingRow } from "../components/SettingRow"
import { useGlobalSDK } from "@/context/global-sdk"
import type { ExperienceDetectResult, ExperienceDetectGroup, ReencodeJobState } from "@ericsanchezok/synergy-sdk/client"
import type { LibrarySettingsStore } from "../types"
import {
  isReencodeJobNotFound,
  pollReencodeJob,
  reencodeConflictJob,
  reencodeJobSummary,
} from "./library-reencode-model"
import { LibraryReencodeProgress } from "./library-reencode-progress"
import type { MessageDescriptor } from "@lingui/core"

/* ---------- option descriptors (labels/details held as descriptors; translated at consumer) ---------- */

interface L10nStepOption {
  value: string
  label: MessageDescriptor
  detail?: MessageDescriptor
  tickLabel?: MessageDescriptor
}

const similarityOptionDefs: L10nStepOption[] = [
  {
    value: "0.5",
    label: { id: "settings.library.similarity.broad", message: "Broad" },
    tickLabel: { id: "settings.library.similarity.broad.tick", message: "0.5" },
    detail: { id: "settings.library.similarity.broad.detail", message: "Loose context match" },
  },
  {
    value: "0.6",
    label: { id: "settings.library.similarity.soft", message: "Soft" },
    tickLabel: { id: "settings.library.similarity.soft.tick", message: "0.6" },
    detail: { id: "settings.library.similarity.soft.detail", message: "More context allowed" },
  },
  {
    value: "0.7",
    label: { id: "settings.library.similarity.balanced", message: "Balanced" },
    tickLabel: { id: "settings.library.similarity.balanced.tick", message: "0.7" },
    detail: { id: "settings.library.similarity.balanced.detail", message: "Default recall balance" },
  },
  {
    value: "0.8",
    label: { id: "settings.library.similarity.focused", message: "Focused" },
    tickLabel: { id: "settings.library.similarity.focused.tick", message: "0.8" },
    detail: { id: "settings.library.similarity.focused.detail", message: "Close context only" },
  },
  {
    value: "0.9",
    label: { id: "settings.library.similarity.strict", message: "Strict" },
    tickLabel: { id: "settings.library.similarity.strict.tick", message: "0.9" },
    detail: { id: "settings.library.similarity.strict.detail", message: "Very close matches" },
  },
]

const memoryCountDefs: L10nStepOption[] = [
  {
    value: "1",
    label: { id: "settings.library.memoryCount.quiet", message: "Quiet" },
    tickLabel: { id: "settings.library.memoryCount.quiet.tick", message: "1" },
    detail: { id: "settings.library.memoryCount.quiet.detail", message: "Minimal recall" },
  },
  {
    value: "2",
    label: { id: "settings.library.memoryCount.lean", message: "Lean" },
    tickLabel: { id: "settings.library.memoryCount.lean.tick", message: "2" },
    detail: { id: "settings.library.memoryCount.lean.detail", message: "Light recall" },
  },
  {
    value: "3",
    label: { id: "settings.library.memoryCount.balanced", message: "Balanced" },
    tickLabel: { id: "settings.library.memoryCount.balanced.tick", message: "3" },
    detail: { id: "settings.library.memoryCount.balanced.detail", message: "Default memory depth" },
  },
  {
    value: "5",
    label: { id: "settings.library.memoryCount.more", message: "More" },
    tickLabel: { id: "settings.library.memoryCount.more.tick", message: "5" },
    detail: { id: "settings.library.memoryCount.more.detail", message: "More context available" },
  },
  {
    value: "8",
    label: { id: "settings.library.memoryCount.full", message: "Full" },
    tickLabel: { id: "settings.library.memoryCount.full.tick", message: "8" },
    detail: { id: "settings.library.memoryCount.full.detail", message: "Maximum memory depth" },
  },
]

const experienceCountDefs: L10nStepOption[] = [
  {
    value: "3",
    label: { id: "settings.library.experienceCount.lean", message: "Lean" },
    tickLabel: { id: "settings.library.experienceCount.lean.tick", message: "3" },
    detail: { id: "settings.library.experienceCount.lean.detail", message: "Few past examples" },
  },
  {
    value: "5",
    label: { id: "settings.library.experienceCount.steady", message: "Steady" },
    tickLabel: { id: "settings.library.experienceCount.steady.tick", message: "5" },
    detail: { id: "settings.library.experienceCount.steady.detail", message: "Moderate recall" },
  },
  {
    value: "8",
    label: { id: "settings.library.experienceCount.balanced", message: "Balanced" },
    tickLabel: { id: "settings.library.experienceCount.balanced.tick", message: "8" },
    detail: { id: "settings.library.experienceCount.balanced.detail", message: "Default experience depth" },
  },
  {
    value: "10",
    label: { id: "settings.library.experienceCount.deep", message: "Deep" },
    tickLabel: { id: "settings.library.experienceCount.deep.tick", message: "10" },
    detail: { id: "settings.library.experienceCount.deep.detail", message: "More examples" },
  },
  {
    value: "15",
    label: { id: "settings.library.experienceCount.full", message: "Full" },
    tickLabel: { id: "settings.library.experienceCount.full.tick", message: "15" },
    detail: { id: "settings.library.experienceCount.full.detail", message: "Maximum experience depth" },
  },
]

const explorationDefs: L10nStepOption[] = [
  {
    value: "0",
    label: { id: "settings.library.exploration.stable", message: "Stable" },
    tickLabel: { id: "settings.library.exploration.stable.tick", message: "0" },
    detail: { id: "settings.library.exploration.stable.detail", message: "Always exploit known paths" },
  },
  {
    value: "0.05",
    label: { id: "settings.library.exploration.careful", message: "Careful" },
    tickLabel: { id: "settings.library.exploration.careful.tick", message: "0.05" },
    detail: { id: "settings.library.exploration.careful.detail", message: "Rare exploration" },
  },
  {
    value: "0.1",
    label: { id: "settings.library.exploration.balanced", message: "Balanced" },
    tickLabel: { id: "settings.library.exploration.balanced.tick", message: "0.1" },
    detail: { id: "settings.library.exploration.balanced.detail", message: "Default exploration" },
  },
  {
    value: "0.2",
    label: { id: "settings.library.exploration.curious", message: "Curious" },
    tickLabel: { id: "settings.library.exploration.curious.tick", message: "0.2" },
    detail: { id: "settings.library.exploration.curious.detail", message: "More alternatives" },
  },
  {
    value: "0.3",
    label: { id: "settings.library.exploration.exploratory", message: "Exploratory" },
    tickLabel: { id: "settings.library.exploration.exploratory.tick", message: "0.3" },
    detail: { id: "settings.library.exploration.exploratory.detail", message: "Frequent alternatives" },
  },
]

function stepOption(_: (desc: MessageDescriptor) => string, def: L10nStepOption): SettingsStepOption {
  return {
    value: def.value,
    label: _(def.label),
    detail: def.detail ? _(def.detail) : undefined,
    tickLabel: def.tickLabel ? _(def.tickLabel) : undefined,
  }
}

/* ---------- page / section descriptors ---------- */

const learningPageTitle = { id: "settings.library.learning.page.title", message: "Learning" }
const learningPageDesc = {
  id: "settings.library.learning.page.desc",
  message: "Decide how Synergy captures and maintains library knowledge.",
}
const captureSectionTitle = { id: "settings.library.learning.capture.title", message: "Capture" }
const captureSectionDesc = {
  id: "settings.library.learning.capture.desc",
  message: "Keep the library useful without turning these controls into raw configuration.",
}
const learnRowTitle = { id: "settings.library.learning.learnRow.title", message: "Learn from interactions" }
const learnRowDesc = {
  id: "settings.library.learning.learnRow.desc",
  message: "Create and curate memories from useful conversation context.",
}
const learningOn = { id: "settings.library.learning.state.learning", message: "Learning" }
const learningPaused = { id: "settings.library.learning.state.paused", message: "Paused" }
const autonomyRowTitle = { id: "settings.library.learning.autonomyRow.title", message: "Autonomous routines" }
const autonomyRowDesc = {
  id: "settings.library.learning.autonomyRow.desc",
  message: "Allow reflection and planning jobs to run quietly in the background.",
}
const autonomyOn = { id: "settings.library.learning.state.automatic", message: "Automatic" }
const autonomyOff = { id: "settings.library.learning.state.manual", message: "Manual" }

const memoryPageTitle = { id: "settings.library.memory.page.title", message: "Memory" }
const memoryPageDesc = {
  id: "settings.library.memory.page.desc",
  message: "Tune how Synergy recalls curated memory while you work.",
}
const recallSectionTitle = { id: "settings.library.memory.recall.title", message: "Recall" }
const recallSectionDesc = {
  id: "settings.library.memory.recall.desc",
  message: "Adjust precision and volume for contextual memories that are brought into a session.",
}
const matchRowTitle = { id: "settings.library.memory.matchRow.title", message: "Match strictness" }
const matchRowDesc = {
  id: "settings.library.memory.matchRow.desc",
  message: "Higher values keep recalled memories closer to the current context.",
}
const countRowTitle = { id: "settings.library.memory.countRow.title", message: "Memories per category" }
const countRowDesc = {
  id: "settings.library.memory.countRow.desc",
  message: "Limit how many memories each category can contribute.",
}
const broaderLow = { id: "settings.library.memory.broader", message: "Broader" }
const stricterHigh = { id: "settings.library.memory.stricter", message: "Stricter" }
const lessContextLow = { id: "settings.library.memory.lessContext", message: "Less context" }
const moreContextHigh = { id: "settings.library.memory.moreContext", message: "More context" }
const memoryMatchAria = { id: "settings.library.memory.matchAria", message: "Memory match strictness" }
const memoryCountAria = { id: "settings.library.memory.countAria", message: "Memories per category" }

const experiencePageTitle = { id: "settings.library.experience.page.title", message: "Experience" }
const experiencePageDesc = {
  id: "settings.library.experience.page.desc",
  message: "Tune how Synergy reuses past task patterns and tries alternatives.",
}
const retrievalSectionTitle = { id: "settings.library.experience.retrieval.title", message: "Retrieval" }
const retrievalSectionDesc = {
  id: "settings.library.experience.retrieval.desc",
  message: "Choose how many past patterns should influence future work.",
}
const expMatchRowTitle = { id: "settings.library.experience.matchRow.title", message: "Match strictness" }
const expMatchRowDesc = {
  id: "settings.library.experience.matchRow.desc",
  message: "Higher values keep recalled experiences closer to the current task.",
}
const expCountRowTitle = { id: "settings.library.experience.countRow.title", message: "Experiences to recall" }
const expCountRowDesc = {
  id: "settings.library.experience.countRow.desc",
  message: "Set how many past examples can be considered at once.",
}
const fewerExpLow = { id: "settings.library.experience.fewer", message: "Fewer" }
const moreExpHigh = { id: "settings.library.experience.more", message: "More" }
const expMatchAria = { id: "settings.library.experience.matchAria", message: "Experience match strictness" }
const expCountAria = { id: "settings.library.experience.countAria", message: "Experiences to recall" }
const explorationSectionTitle = { id: "settings.library.experience.exploration.title", message: "Exploration" }
const explorationSectionDesc = {
  id: "settings.library.experience.exploration.desc",
  message: "Control how often Synergy tries a less familiar path.",
}
const expEpsilonRowTitle = { id: "settings.library.experience.epsilonRow.title", message: "Exploration rate" }
const expEpsilonRowDesc = {
  id: "settings.library.experience.epsilonRow.desc",
  message: "Chance of exploring alternatives instead of using the best-known pattern.",
}
const stableLow = { id: "settings.library.experience.stableLow", message: "Stable" }
const exploratoryHigh = { id: "settings.library.experience.exploratoryHigh", message: "Exploratory" }
const expEpsilonAria = { id: "settings.library.experience.epsilonAria", message: "Experience exploration rate" }

/* encoding health section */
const encodingHealthTitle = { id: "settings.library.encoding.health.title", message: "Encoding Health" }
const encodingHealthDesc = {
  id: "settings.library.encoding.health.desc",
  message: "Scan the database for records whose intent or script may not have been properly encoded.",
}
const intentIssuesLabel = { id: "settings.library.encoding.intentIssues", message: "Intent issues" }
const scriptIssuesLabel = { id: "settings.library.encoding.scriptIssues", message: "Script issues" }
const lastScannedLabel = { id: "settings.library.encoding.lastScanned", message: "Last scanned" }
const notScannedYet = { id: "settings.library.encoding.notScanned", message: "Not scanned yet" }
const intentIssuesTitle = { id: "settings.library.encoding.intentIssues.title", message: "Intent Issues" }
const scriptIssuesTitle = { id: "settings.library.encoding.scriptIssues.title", message: "Script Issues" }

function reencodeButtonLabel(kind: string, total: string) {
  return {
    id: "settings.library.encoding.reencodeButton",
    message: "Re-encode {kind} for all {total} records",
    values: { kind, total },
  }
}
const estimatedLabel = { id: "settings.library.encoding.estimated", message: "Estimated:" }

const reencodeStatusUnavailableTitle = {
  id: "settings.library.reencode.unavailable",
  message: "Re-encoding status unavailable",
}
const reencodeHistoryUnavailableTitle = {
  id: "settings.library.reencode.historyUnavailable",
  message: "Re-encoding history unavailable",
}
const reencodeStartErrorTitle = { id: "settings.library.reencode.startError", message: "Re-encoding could not start" }
const reencodeCancelErrorTitle = {
  id: "settings.library.reencode.cancelError",
  message: "Re-encoding could not be cancelled",
}
const allHealthyText = { id: "settings.library.encoding.allHealthy", message: "All experience records are healthy." }
const jobLoadFallback = {
  id: "settings.library.encoding.jobLoadFallback",
  message: "The current job could not be loaded.",
}
const historyLoadFallback = {
  id: "settings.library.encoding.historyLoadFallback",
  message: "The latest job could not be loaded.",
}
const startJobFallback = { id: "settings.library.encoding.startJobFallback", message: "The job could not be started." }
const cancelJobFallback = { id: "settings.library.encoding.cancelJobFallback", message: "The job is still running." }

const scanNowDescriptor = { id: "settings.library.encoding.scanNow", message: "Scan Now" }
const scanningDescriptor = {
  id: "settings.library.encoding.scanning",
  message: "Scanning\u2026",
}
const showSamplesDescriptor = {
  id: "settings.library.encoding.showSamples",
  message: "\u25B8 Show samples",
}
const hideSamplesDescriptor = {
  id: "settings.library.encoding.hideSamples",
  message: "\u25BE Hide samples",
}
function scanNowLabel(scanning: boolean) {
  return scanning ? scanningDescriptor : scanNowDescriptor
}
function hideSamplesLabel(expanded: boolean) {
  return expanded ? hideSamplesDescriptor : showSamplesDescriptor
}

/* ICU-driven estimate (LLM calls / duration) */
function estimateDescriptor(callCount: number) {
  const secs = Math.ceil((callCount * 2) / 5)
  const minutes = secs < 60 ? undefined : Math.ceil(secs / 60)
  if (!minutes)
    return {
      id: "settings.library.encoding.estimateSeconds",
      message: "~{count} LLM calls, ~{secs} seconds",
      values: { count: callCount, secs },
    }
  return {
    id: "settings.library.encoding.estimateMinutes",
    message: "~{count} LLM calls, ~{mins}-{maxMins} minutes",
    values: { count: callCount, mins: minutes, maxMins: minutes + 1 },
  }
}

/* ---------- components ---------- */

export function LearningPanel(props: {
  library: LibrarySettingsStore
  onLibraryChange: (key: keyof LibrarySettingsStore, value: string) => void
}) {
  const { _ } = useLingui()
  return (
    <SettingsPage title={_(learningPageTitle)} description={_(learningPageDesc)}>
      <SettingsSection title={_(captureSectionTitle)} description={_(captureSectionDesc)}>
        <SettingRow
          title={_(learnRowTitle)}
          description={_(learnRowDesc)}
          trailing={
            <>
              <span class="settings-row-state">
                {props.library.learning !== "false" ? _(learningOn) : _(learningPaused)}
              </span>
              <Switch
                checked={props.library.learning !== "false"}
                hideLabel
                onChange={(value) => props.onLibraryChange("learning", value ? "true" : "false")}
              >
                {_(learnRowTitle)}
              </Switch>
            </>
          }
        />
        <SettingRow
          title={_(autonomyRowTitle)}
          description={_(autonomyRowDesc)}
          trailing={
            <>
              <span class="settings-row-state">
                {props.library.autonomy !== "false" ? _(autonomyOn) : _(autonomyOff)}
              </span>
              <Switch
                checked={props.library.autonomy !== "false"}
                hideLabel
                onChange={(value) => props.onLibraryChange("autonomy", value ? "true" : "false")}
              >
                {_(autonomyRowTitle)}
              </Switch>
            </>
          }
        />
      </SettingsSection>
    </SettingsPage>
  )
}

export function MemoryPanel(props: {
  library: LibrarySettingsStore
  onLibraryChange: (key: keyof LibrarySettingsStore, value: string) => void
}) {
  const { _ } = useLingui()
  const opts = () => memoryCountDefs.map((def) => stepOption(_, def))
  const simOpts = () => similarityOptionDefs.map((def) => stepOption(_, def))
  return (
    <SettingsPage title={_(memoryPageTitle)} description={_(memoryPageDesc)}>
      <SettingsSection title={_(recallSectionTitle)} description={_(recallSectionDesc)}>
        <SettingRow
          title={_(matchRowTitle)}
          description={_(matchRowDesc)}
          trailing={
            <SettingsStepScale
              value={props.library.memorySimThreshold}
              options={simOpts()}
              lowLabel={_(broaderLow)}
              highLabel={_(stricterHigh)}
              ariaLabel={_(memoryMatchAria)}
              summary={(option) => `${option.label} ${option.value}`}
              onChange={(value) => props.onLibraryChange("memorySimThreshold", value)}
            />
          }
        />
        <SettingRow
          title={_(countRowTitle)}
          description={_(countRowDesc)}
          trailing={
            <SettingsStepScale
              value={props.library.memoryTopK}
              options={opts()}
              lowLabel={_(lessContextLow)}
              highLabel={_(moreContextHigh)}
              ariaLabel={_(memoryCountAria)}
              summary={(option) => `${option.label} ${option.value}`}
              onChange={(value) => props.onLibraryChange("memoryTopK", value)}
            />
          }
        />
      </SettingsSection>
    </SettingsPage>
  )
}

function EncodingHealthSection() {
  const { _ } = useLingui()
  const { fmt } = useLocale()
  const globalSDK = useGlobalSDK()
  const confirm = useConfirm()

  const [scanning, setScanning] = createSignal(false)
  const [result, setResult] = createSignal<ExperienceDetectResult | null>(null)
  const [reencoding, setReencoding] = createSignal<ReencodeJobState | null>(null)
  const [reencodeDone, setReencodeDone] = createSignal<ReencodeJobState | null>(null)
  const [cancelling, setCancelling] = createSignal(false)
  let observer: AbortController | undefined
  let disposed = false

  const hasIssues = createMemo(() => {
    const r = result()
    if (!r) return false
    return r.intent.total > 0 || r.script.total > 0
  })

  function applyJob(job: ReencodeJobState) {
    if (job.status === "running") {
      setReencoding(job)
      setReencodeDone(null)
      return
    }
    setReencoding(null)
    setReencodeDone(job)
  }

  async function loadCurrentJob() {
    const response = await globalSDK.client.library.experience.getReencodeJob()
    if (response.error) throw response.error
    return response.data
  }

  async function observeJob(job: ReencodeJobState) {
    observer?.abort()
    const controller = new AbortController()
    observer = controller
    applyJob(job)
    try {
      await pollReencodeJob({
        load: loadCurrentJob,
        onUpdate: applyJob,
        signal: controller.signal,
      })
    } catch (error) {
      if (controller.signal.aborted || disposed) return
      setReencoding(null)
      showToast({
        type: "error",
        title: _(reencodeStatusUnavailableTitle),
        description: error instanceof Error ? error.message : _(jobLoadFallback),
      })
    } finally {
      if (observer === controller) observer = undefined
    }
  }

  onMount(() => {
    void (async () => {
      try {
        const response = await globalSDK.client.library.experience.getReencodeJob()
        if (response.error) {
          if (isReencodeJobNotFound(response.error)) return
          throw response.error
        }
        if (disposed) return
        if (response.data.status === "running") void observeJob(response.data)
        else applyJob(response.data)
      } catch (error) {
        if (disposed) return
        showToast({
          type: "error",
          title: _(reencodeHistoryUnavailableTitle),
          description: error instanceof Error ? error.message : _(historyLoadFallback),
        })
      }
    })()
  })

  onCleanup(() => {
    disposed = true
    observer?.abort()
  })

  async function handleScan() {
    setScanning(true)
    setReencodeDone(null)
    try {
      const res = await globalSDK.client.library.experience.detect()
      if (res.error) throw res.error
      setResult(res.data)
    } catch {
      // scan fails silently — button re-enabled
    } finally {
      setScanning(false)
    }
  }

  function handleReencode(kind: "intent" | "script", reason?: string) {
    if (reencoding()) return
    const r = result()
    const total = kind === "intent" ? (r?.intent.total ?? 0) : (r?.script.total ?? 0)
    confirm.show({
      ...reencodeExperienceConfirm(kind, total),
      onConfirm: () => {
        void startReencode(kind, reason)
      },
    })
  }

  async function startReencode(kind: "intent" | "script", reason?: string) {
    setReencodeDone(null)
    try {
      const response = await globalSDK.client.library.experience.startReencodeJob({ type: kind, reason })
      const job = response.error ? reencodeConflictJob(response.error) : response.data
      if (!job) throw response.error
      if (job.status === "running") void observeJob(job)
      else applyJob(job)
    } catch (error) {
      showToast({
        type: "error",
        title: _(reencodeStartErrorTitle),
        description: error instanceof Error ? error.message : _(startJobFallback),
      })
    }
  }

  function handleCancel() {
    const current = reencoding()
    if (!current || cancelling()) return
    confirm.show({
      ...cancelReencodeConfirm(current.completedCount, current.totalCount),
      async onConfirm() {
        setCancelling(true)
        try {
          const response = await globalSDK.client.library.experience.cancelReencodeJob()
          if (response.error) throw response.error
          observer?.abort()
          applyJob(response.data)
        } catch (error) {
          showToast({
            type: "error",
            title: _(reencodeCancelErrorTitle),
            description: error instanceof Error ? error.message : _(cancelJobFallback),
          })
        } finally {
          setCancelling(false)
        }
      },
    })
  }

  const scannedAtText = createMemo(() => {
    const r = result()
    if (!r) return _(notScannedYet)
    return fmt.relative(r.scannedAt)
  })

  return (
    <SettingsSection title={_(encodingHealthTitle)} description={_(encodingHealthDesc)}>
      <div class="usage-overview">
        <div class="usage-overview-metrics">
          <div class="usage-overview-metric">
            <span class="usage-overview-value">{result()?.intent.total ?? "\u2014"}</span>
            <span class="usage-overview-label">{_(intentIssuesLabel)}</span>
          </div>
          <div class="usage-overview-metric">
            <span class="usage-overview-value">{result()?.script.total ?? "\u2014"}</span>
            <span class="usage-overview-label">{_(scriptIssuesLabel)}</span>
          </div>
          <div class="usage-overview-metric">
            <span class="usage-overview-value usage-overview-date">{scannedAtText()}</span>
            <span class="usage-overview-label">{_(lastScannedLabel)}</span>
          </div>
        </div>
        <div class="usage-overview-actions">
          <Button
            type="button"
            variant={result() ? "secondary" : "primary"}
            size="small"
            icon={getSemanticIcon(scanning() ? "action.refresh" : "action.search")}
            disabled={scanning() || reencoding() !== null}
            onClick={handleScan}
          >
            {_(scanNowLabel(scanning()))}
          </Button>
        </div>
      </div>

      <Show when={reencoding()}>
        {(reenc) => <LibraryReencodeProgress job={reenc} cancelling={cancelling()} onCancel={handleCancel} />}
      </Show>

      <Show when={reencodeDone()}>
        {(done) => (
          <div
            class="ds-setting-subsection"
            style={{ color: done().status === "completed" ? "var(--icon-success-base)" : "var(--text-weak)" }}
          >
            <span>{reencodeJobSummary(done())}</span>
          </div>
        )}
      </Show>

      <Show when={!reencoding() && result() && !hasIssues()}>
        <div
          class="ds-setting-subsection"
          style={{ color: "var(--icon-success-base)", "font-weight": "var(--font-weight-medium)" }}
        >
          {_(allHealthyText)}
        </div>
      </Show>

      <Show when={!reencoding() && result() && hasIssues()}>
        <ExperienceGroupCards
          kind="intent"
          groups={result()!.intent.groups}
          disabled={reencoding() !== null || scanning()}
          onReencode={(reason) => handleReencode("intent", reason)}
        />
        <ExperienceGroupCards
          kind="script"
          groups={result()!.script.groups}
          disabled={reencoding() !== null || scanning()}
          onReencode={(reason) => handleReencode("script", reason)}
        />
      </Show>
    </SettingsSection>
  )
}

function ExperienceGroupCards(props: {
  kind: "intent" | "script"
  groups: ExperienceDetectGroup[]
  disabled: boolean
  onReencode: (reason?: string) => void
}) {
  const { _ } = useLingui()
  const { fmt } = useLocale()
  if (props.groups.length === 0) return null

  const title = props.kind === "intent" ? _(intentIssuesTitle) : _(scriptIssuesTitle)
  const total = props.groups.reduce((sum, g) => sum + g.count, 0)

  return (
    <SettingsSubsection title={title}>
      <For each={props.groups}>
        {(group) => {
          const [expanded, setExpanded] = createSignal(false)
          return (
            <div style={{ "margin-bottom": "10px" }}>
              <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between" }}>
                <div>
                  <span class="usage-overview-value" style={{ "font-size": "var(--settings-type-body-size)" }}>
                    {group.label}
                  </span>
                  <span class="usage-overview-label" style={{ "margin-left": "8px" }}>
                    {fmt.number(group.count)}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setExpanded((v) => !v)}
                  style={{
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    color: "var(--text-weaker)",
                    "font-size": "var(--settings-type-caption-size)",
                  }}
                >
                  <Show when={group.samples.length > 0}>{_(hideSamplesLabel(expanded()))}</Show>
                </button>
              </div>
              <Show when={expanded() && group.samples.length > 0}>
                <div
                  style={{
                    "margin-top": "6px",
                    "padding-left": "8px",
                    "border-left": "1px solid var(--settings-border)",
                  }}
                >
                  <For each={group.samples}>
                    {(sample) => (
                      <div style={{ "margin-bottom": "4px" }}>
                        <span
                          class="usage-overview-label"
                          style={{ "font-family": "var(--font-mono)", "font-size": "11px" }}
                        >
                          {sample.id.slice(0, 12)}
                          {<>{String.fromCodePoint(0x2026)}</>}
                        </span>
                        <span class="usage-overview-label" style={{ "margin-left": "8px" }}>
                          {sample.detail}
                        </span>
                        <Show when={sample.preview}>
                          <div class="usage-overview-label" style={{ "font-size": "11px", opacity: 0.7 }}>
                            {sample.preview}
                          </div>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          )
        }}
      </For>
      <div style={{ "margin-top": "12px" }}>
        <Button
          type="button"
          variant="secondary"
          size="small"
          disabled={props.disabled}
          onClick={() => props.onReencode(undefined)}
        >
          {_(reencodeButtonLabel(props.kind, fmt.number(total)))}
        </Button>
        <span class="usage-overview-label" style={{ "margin-left": "8px" }}>
          {_(estimatedLabel)} {_(estimateDescriptor(total))}
        </span>
      </div>
    </SettingsSubsection>
  )
}

export function ExperiencePanel(props: {
  library: LibrarySettingsStore
  onLibraryChange: (key: keyof LibrarySettingsStore, value: string) => void
}) {
  const { _ } = useLingui()
  const simOpts = () => similarityOptionDefs.map((def) => stepOption(_, def))
  const expCountOpts = () => experienceCountDefs.map((def) => stepOption(_, def))
  const epsOpts = () => explorationDefs.map((def) => stepOption(_, def))
  return (
    <SettingsPage title={_(experiencePageTitle)} description={_(experiencePageDesc)}>
      <SettingsSection title={_(retrievalSectionTitle)} description={_(retrievalSectionDesc)}>
        <SettingRow
          title={_(expMatchRowTitle)}
          description={_(expMatchRowDesc)}
          trailing={
            <SettingsStepScale
              value={props.library.experienceSimThreshold}
              options={simOpts()}
              lowLabel={_(broaderLow)}
              highLabel={_(stricterHigh)}
              ariaLabel={_(expMatchAria)}
              summary={(option) => `${option.label} ${option.value}`}
              onChange={(value) => props.onLibraryChange("experienceSimThreshold", value)}
            />
          }
        />
        <SettingRow
          title={_(expCountRowTitle)}
          description={_(expCountRowDesc)}
          trailing={
            <SettingsStepScale
              value={props.library.experienceTopK}
              options={expCountOpts()}
              lowLabel={_(fewerExpLow)}
              highLabel={_(moreExpHigh)}
              ariaLabel={_(expCountAria)}
              summary={(option) => `${option.label} ${option.value}`}
              onChange={(value) => props.onLibraryChange("experienceTopK", value)}
            />
          }
        />
      </SettingsSection>
      <SettingsSection title={_(explorationSectionTitle)} description={_(explorationSectionDesc)}>
        <SettingRow
          title={_(expEpsilonRowTitle)}
          description={_(expEpsilonRowDesc)}
          trailing={
            <SettingsStepScale
              value={props.library.experienceEpsilon}
              options={epsOpts()}
              lowLabel={_(stableLow)}
              highLabel={_(exploratoryHigh)}
              ariaLabel={_(expEpsilonAria)}
              summary={(option) => `${option.label} ${option.value}`}
              onChange={(value) => props.onLibraryChange("experienceEpsilon", value)}
            />
          }
        />
      </SettingsSection>
      <EncodingHealthSection />
    </SettingsPage>
  )
}
