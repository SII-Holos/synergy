import type { MessageDescriptor } from "@lingui/core"

import { useLingui } from "@lingui/solid"
import type { Agent, CortexConcurrencyStatus } from "@ericsanchezok/synergy-sdk/client"
import { For } from "solid-js"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { SettingRow } from "../components/SettingRow"
import { SettingsStepScale } from "../components/SettingsStepScale"
import { SettingsFieldGrid, SettingsPage, SettingsSection } from "../components/SettingsPrimitives"
import type { RuntimeStore } from "../types"

const managedByEnvLabel = { id: "settings.runtime.managedByEnv", message: "Managed by environment" }

/* Questions */
const questionsPageTitle = { id: "settings.runtime.questions.page.title", message: "Questions" }
const questionsPageDesc = { id: "settings.runtime.questions.page.desc", message: "Question timeout behavior." }
const timeoutSectionTitle = { id: "settings.runtime.questions.timeout.title", message: "Timeout" }
const responseRowTitle = { id: "settings.runtime.questions.responseRow.title", message: "Response Timeout" }
const responseRowDesc = {
  id: "settings.runtime.questions.responseRow.desc",
  message: "Auto-expire unanswered questions",
}
const responseAria = { id: "settings.runtime.questions.responseAria", message: "Question response timeout" }

const questionTimeoutOpts = [
  { value: "0", label: { id: "settings.runtime.questions.timeout.never", message: "Never" } },
  { value: "300", label: { id: "settings.runtime.questions.timeout.5min", message: "5 min" } },
  { value: "600", label: { id: "settings.runtime.questions.timeout.10min", message: "10 min" } },
  { value: "1800", label: { id: "settings.runtime.questions.timeout.30min", message: "30 min" } },
  { value: "3600", label: { id: "settings.runtime.questions.timeout.60min", message: "60 min" } },
]

/* Compaction */
const compactionPageTitle = { id: "settings.runtime.compaction.page.title", message: "Compaction" }
const compactionPageDesc = {
  id: "settings.runtime.compaction.page.desc",
  message: "Session compaction and history limits.",
}
const ctxSectionTitle = { id: "settings.runtime.compaction.ctx.title", message: "Context Management" }
const autoCompactRowTitle = { id: "settings.runtime.compaction.autoCompact.title", message: "Auto Compact" }
const autoCompactRowDesc = {
  id: "settings.runtime.compaction.autoCompact.desc",
  message: "Compact sessions when context is full",
}
const pruneRowTitle = { id: "settings.runtime.compaction.prune.title", message: "Prune Tool Output" }
const pruneRowDesc = {
  id: "settings.runtime.compaction.prune.desc",
  message: "Prune old tool outputs during compaction",
}
const overflowRowTitle = { id: "settings.runtime.compaction.overflow.title", message: "Overflow Threshold" }
const overflowRowDesc = {
  id: "settings.runtime.compaction.overflow.desc",
  message: "Context usage fraction that triggers auto-compaction",
}
const overflowAria = { id: "settings.runtime.compaction.overflowAria", message: "Compaction overflow threshold" }
const maxImagesRowTitle = { id: "settings.runtime.compaction.maxImages.title", message: "Max History Images" }
const maxImagesRowDesc = {
  id: "settings.runtime.compaction.maxImages.desc",
  message: "Maximum historical images sent as base64 per request",
}
const maxImagesAria = { id: "settings.runtime.compaction.maxImagesAria", message: "Maximum history images" }

const overflowOpts = [
  { value: "0.70", label: { id: "settings.runtime.compaction.overflow.70", message: "70%" } },
  { value: "0.80", label: { id: "settings.runtime.compaction.overflow.80", message: "80%" } },
  { value: "0.85", label: { id: "settings.runtime.compaction.overflow.85", message: "85%" } },
  { value: "0.90", label: { id: "settings.runtime.compaction.overflow.90", message: "90%" } },
  { value: "0.95", label: { id: "settings.runtime.compaction.overflow.95", message: "95%" } },
]
const maxImageOpts = [
  { value: "0", label: { id: "settings.runtime.compaction.images.0", message: "0" } },
  { value: "4", label: { id: "settings.runtime.compaction.images.4", message: "4" } },
  { value: "8", label: { id: "settings.runtime.compaction.images.8", message: "8" } },
  { value: "12", label: { id: "settings.runtime.compaction.images.12", message: "12" } },
  { value: "16", label: { id: "settings.runtime.compaction.images.16", message: "16" } },
]

/* Agents */
const agentsPageTitle = { id: "settings.runtime.agents.page.title", message: "Agents" }
const agentsPageDesc = {
  id: "settings.runtime.agents.page.desc",
  message: "Agent prompt behavior, provider timeouts, and tool timeout controls.",
}
const agentSectionTitle = { id: "settings.runtime.agents.agent.title", message: "Agent" }
const coauthorRowTitle = { id: "settings.runtime.agents.coauthor.title", message: "Co-author Reminder" }
const coauthorRowDesc = {
  id: "settings.runtime.agents.coauthor.desc",
  message: "Remind agents to include the Synergy co-author footer when creating git commits.",
}
const defaultAgentRowTitle = { id: "settings.runtime.agents.defaultAgent.title", message: "Default Agent" }
const defaultAgentRowDesc = {
  id: "settings.runtime.agents.defaultAgent.desc",
  message: "Primary agent for new conversations. Hidden and subagent definitions are excluded.",
}
const invokeRowTitle = { id: "settings.runtime.agents.invoke.title", message: "Invoke Timeout" }
const invokeRowDesc = {
  id: "settings.runtime.agents.invoke.desc",
  message: "Milliseconds before a task invoke call times out.",
}
const concurrencyRowTitle = { id: "settings.runtime.agents.concurrency.title", message: "Max Concurrent Subagents" }
const concurrencyRowDesc = {
  id: "settings.runtime.agents.concurrency.desc",
  message: "Maximum Cortex subagent tasks running at once. The runtime temporarily lowers the active limit under memory pressure.",
}
const providerSectionTitle = { id: "settings.runtime.agents.provider.title", message: "Provider" }
const ttfbRowTitle = { id: "settings.runtime.agents.ttfb.title", message: "TTFB Timeout" }
const ttfbRowDesc = {
  id: "settings.runtime.agents.ttfb.desc",
  message: "Milliseconds to wait for the first response byte from a provider.",
}
const idleRowTitle = { id: "settings.runtime.agents.idle.title", message: "Idle Timeout" }
const idleRowDesc = {
  id: "settings.runtime.agents.idle.desc",
  message: "Milliseconds of provider inactivity before the connection is dropped.",
}
const wallRowTitle = { id: "settings.runtime.agents.wall.title", message: "Wall Timeout" }
const wallRowDesc = {
  id: "settings.runtime.agents.wall.desc",
  message: "Hard cap in milliseconds for the total provider call duration.",
}
const toolsSectionTitle = { id: "settings.runtime.agents.tools.title", message: "Tools" }
const toolTimeoutRowTitle = { id: "settings.runtime.agents.toolTimeout.title", message: "Default Tool Timeout" }
const toolTimeoutRowDesc = {
  id: "settings.runtime.agents.toolTimeout.desc",
  message: "Milliseconds before a tool execution attempt times out.",
}
const overridesRowTitle = { id: "settings.runtime.agents.overrides.title", message: "Tool Overrides" }
const overridesRowDesc = {
  id: "settings.runtime.agents.overrides.desc",
  message: "Per-tool timeout overrides as JSON or key-value pairs.",
}

/* Observability */
const observPageTitle = { id: "settings.runtime.observ.page.title", message: "Observability" }
const observPageDesc = { id: "settings.runtime.observ.page.desc", message: "Logs, traces, and diagnostics." }
const loggingSectionTitle = { id: "settings.runtime.observ.logging.title", message: "Logging" }
const logLevelRowTitle = { id: "settings.runtime.observ.logLevel.title", message: "Log Level" }
const logLevelRowDesc = {
  id: "settings.runtime.observ.logLevel.desc",
  message: "Minimum log severity captured by the runtime logger.",
}
const watcherRowTitle = { id: "settings.runtime.observ.watcher.title", message: "Watcher Ignore" }
const watcherRowDesc = {
  id: "settings.runtime.observ.watcher.desc",
  message: "Patterns the file watcher should skip, one per line.",
}

function withLabel(def: { value: string; label: MessageDescriptor }, _: (d: MessageDescriptor) => string) {
  return { value: def.value, label: _(def.label) }
}

export function QuestionsPanel(props: {
  runtime: RuntimeStore
  onRuntimeChange: (key: keyof RuntimeStore, value: string) => void
}) {
  const { _ } = useLingui()
  return (
    <SettingsPage title={_(questionsPageTitle)} description={_(questionsPageDesc)}>
      <SettingsSection title={_(timeoutSectionTitle)}>
        <SettingRow
          title={_(responseRowTitle)}
          description={_(responseRowDesc)}
          trailing={
            <SettingsStepScale
              value={props.runtime.questionTimeout}
              ariaLabel={_(responseAria)}
              options={questionTimeoutOpts.map((o) => withLabel(o, _))}
              onChange={(value) => props.onRuntimeChange("questionTimeout", value)}
            />
          }
        />
      </SettingsSection>
    </SettingsPage>
  )
}

export function CompactionPanel(props: {
  runtime: RuntimeStore
  onRuntimeChange: (key: keyof RuntimeStore, value: string) => void
}) {
  const { _ } = useLingui()
  return (
    <SettingsPage title={_(compactionPageTitle)} description={_(compactionPageDesc)}>
      <SettingsSection title={_(ctxSectionTitle)}>
        <SettingRow
          title={_(autoCompactRowTitle)}
          description={_(autoCompactRowDesc)}
          trailing={
            <Switch
              checked={props.runtime.compactionAuto !== "false"}
              onChange={(value) => props.onRuntimeChange("compactionAuto", value ? "true" : "false")}
            />
          }
        />
        <SettingRow
          title={_(pruneRowTitle)}
          description={_(pruneRowDesc)}
          trailing={
            <Switch
              checked={props.runtime.compactionPrune !== "false"}
              onChange={(value) => props.onRuntimeChange("compactionPrune", value ? "true" : "false")}
            />
          }
        />
        <SettingRow
          title={_(overflowRowTitle)}
          description={_(overflowRowDesc)}
          trailing={
            <SettingsStepScale
              value={props.runtime.compactionOverflowThreshold}
              ariaLabel={_(overflowAria)}
              options={overflowOpts.map((o) => withLabel(o, _))}
              onChange={(value) => props.onRuntimeChange("compactionOverflowThreshold", value)}
            />
          }
        />
        <SettingRow
          title={_(maxImagesRowTitle)}
          description={_(maxImagesRowDesc)}
          trailing={
            <SettingsStepScale
              value={props.runtime.compactionMaxHistoryImages}
              ariaLabel={_(maxImagesAria)}
              options={maxImageOpts.map((o) => withLabel(o, _))}
              onChange={(value) => props.onRuntimeChange("compactionMaxHistoryImages", value)}
            />
          }
        />
      </SettingsSection>
    </SettingsPage>
  )
}

export function TimeoutsPanel(props: {
  runtime: RuntimeStore
  onRuntimeChange: (key: keyof RuntimeStore, value: string) => void
  availableAgents: Agent[]
  defaultAgent: string
  onDefaultAgentChange: (agent: string) => void
  concurrencyStatus?: CortexConcurrencyStatus
}) {
  const { _ } = useLingui()
  const environmentConcurrency = () => props.concurrencyStatus?.environment
  const managedByEnvironment = () => environmentConcurrency() !== null && environmentConcurrency() !== undefined
  const displayedConcurrency = () =>
    managedByEnvironment() ? String(environmentConcurrency()) : props.runtime.cortexConcurrency
  const concurrencyStateLabel = () => {
    const memoryPressureLimit = props.concurrencyStatus?.memoryPressureLimit
    if (memoryPressureLimit !== null && memoryPressureLimit !== undefined) {
      if (managedByEnvironment()) {
        return _({
          id: "settings.runtime.agents.concurrency.memorySafetyManaged",
          message: "Managed by environment · Memory safety limit: {value}",
          values: { value: String(memoryPressureLimit) },
        })
      }
      return _({
        id: "settings.runtime.agents.concurrency.memorySafety",
        message: "Memory safety limit: {value}",
        values: { value: String(memoryPressureLimit) },
      })
    }
    if (managedByEnvironment()) return _(managedByEnvLabel)
    return undefined
  }

  const resetInvalidConcurrency = () => {
    const parsed = Number(props.runtime.cortexConcurrency)
    if (Number.isInteger(parsed) && parsed > 0) return
    props.onRuntimeChange(
      "cortexConcurrency",
      String(props.concurrencyStatus?.configured ?? props.concurrencyStatus?.effective ?? 8),
    )
  }

  return (
    <SettingsPage title={_(agentsPageTitle)} description={_(agentsPageDesc)}>
      <SettingsSection title={_(agentSectionTitle)}>
        <SettingRow
          title={_(coauthorRowTitle)}
          description={_(coauthorRowDesc)}
          trailing={
            <Switch
              checked={props.runtime.coauthorReminder !== "false"}
              onChange={(value) => props.onRuntimeChange("coauthorReminder", value ? "true" : "false")}
            />
          }
        />
        <SettingRow
          title={_(defaultAgentRowTitle)}
          description={_(defaultAgentRowDesc)}
          trailing={
            <select
              class="settings-select"
              value={props.defaultAgent}
              onChange={(event) => props.onDefaultAgentChange(event.currentTarget.value)}
            >
              <For each={props.availableAgents}>{(agent) => <option value={agent.name}>{agent.name}</option>}</For>
            </select>
          }
        />
        <SettingRow
          title={_(invokeRowTitle)}
          description={_(invokeRowDesc)}
          trailing={
            <TextField
              type="number"
              value={props.runtime.invokeTimeout}
              placeholder="900"
              class="settings-row-control-text"
              onChange={(value) => props.onRuntimeChange("invokeTimeout", value)}
            />
          }
        />
        <SettingRow
          title={_(concurrencyRowTitle)}
          description={_(concurrencyRowDesc)}
          stateLabel={concurrencyStateLabel()}
          trailing={
            <TextField
              type="number"
              min="1"
              step="1"
              value={displayedConcurrency()}
              placeholder="8"
              disabled={managedByEnvironment()}
              class="settings-row-control-text"
              onBlur={resetInvalidConcurrency}
              onChange={(value) => props.onRuntimeChange("cortexConcurrency", value)}
            />
          }
        />
      </SettingsSection>
      <SettingsSection title={_(providerSectionTitle)}>
        <SettingRow
          title={_(ttfbRowTitle)}
          description={_(ttfbRowDesc)}
          trailing={
            <TextField
              type="number"
              value={props.runtime.providerTtfbTimeout}
              placeholder="600"
              class="settings-row-control-text"
              onChange={(value) => props.onRuntimeChange("providerTtfbTimeout", value)}
            />
          }
        />
        <SettingRow
          title={_(idleRowTitle)}
          description={_(idleRowDesc)}
          trailing={
            <TextField
              type="number"
              value={props.runtime.providerIdleTimeout}
              placeholder="180"
              class="settings-row-control-text"
              onChange={(value) => props.onRuntimeChange("providerIdleTimeout", value)}
            />
          }
        />
        <SettingRow
          title={_(wallRowTitle)}
          description={_(wallRowDesc)}
          trailing={
            <TextField
              type="number"
              value={props.runtime.providerWallTimeout}
              placeholder="0"
              class="settings-row-control-text"
              onChange={(value) => props.onRuntimeChange("providerWallTimeout", value)}
            />
          }
        />
      </SettingsSection>
      <SettingsSection title={_(toolsSectionTitle)}>
        <SettingRow
          title={_(toolTimeoutRowTitle)}
          description={_(toolTimeoutRowDesc)}
          trailing={
            <TextField
              type="number"
              value={props.runtime.toolDefaultTimeout}
              placeholder="300"
              class="settings-row-control-text"
              onChange={(value) => props.onRuntimeChange("toolDefaultTimeout", value)}
            />
          }
        />
        <SettingRow
          title={_(overridesRowTitle)}
          description={_(overridesRowDesc)}
          trailing={
            <TextField
              type="text"
              multiline
              value={props.runtime.toolOverrides}
              placeholder="bash=600\nwebfetch=120"
              class="settings-row-control-text"
              onChange={(value) => props.onRuntimeChange("toolOverrides", value)}
            />
          }
        />
      </SettingsSection>
    </SettingsPage>
  )
}

export function ObservabilityPanel(props: {
  runtime: RuntimeStore
  onRuntimeChange: (key: keyof RuntimeStore, value: string) => void
}) {
  const { _ } = useLingui()
  return (
    <SettingsPage title={_(observPageTitle)} description={_(observPageDesc)}>
      <SettingsSection title={_(loggingSectionTitle)}>
        <SettingRow
          title={_(logLevelRowTitle)}
          description={_(logLevelRowDesc)}
          trailing={
            <TextField
              type="text"
              value={props.runtime.logLevel}
              placeholder="info"
              class="settings-row-control-text"
              onChange={(value) => props.onRuntimeChange("logLevel", value)}
            />
          }
        />
        <SettingRow
          title={_(watcherRowTitle)}
          description={_(watcherRowDesc)}
          trailing={
            <TextField
              type="text"
              multiline
              value={props.runtime.watcherIgnore}
              placeholder="node_modules\n.git"
              class="settings-row-control-text"
              onChange={(value) => props.onRuntimeChange("watcherIgnore", value)}
            />
          }
        />
      </SettingsSection>
    </SettingsPage>
  )
}
