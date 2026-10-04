import { getAgentVisual } from "../../agent-visual"
import { defaultPrimaryAgent } from "../../agent-selection"
import { settingsFieldCopy } from "../settings-field-copy"
import type { MessageDescriptor } from "@lingui/core"

import { useLingui } from "@lingui/solid"
import type { Agent, AgentWorkerCapacityStatus, CortexConcurrencyStatus } from "@ericsanchezok/synergy-sdk/client"
import { For, Show } from "solid-js"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { SettingRow } from "../components/SettingsSettingRow"
import { MenuField } from "@ericsanchezok/synergy-ui/menu-field"
import { SettingsStepScale } from "../components/SettingsStepScale"
import {
  SettingsAdvanced,
  SettingsFieldGrid,
  SettingsPage,
  SettingsPathRow,
  SettingsSection,
} from "../components/SettingsPrimitives"
import type { RuntimeStore } from "../types"
import type { DesktopShellEnvironmentDiagnostics } from "@/context/platform"
import { concurrencyPressureState } from "./runtime-concurrency-model"
import { agentWorkerCapacityDisplay } from "./runtime-agent-workers-model"
import { translateDescriptor } from "@/locales/translate"

const managedByEnvLabel = { id: "settings.runtime.managedByEnv", message: "Managed by environment" }

/* Questions */
const questionsPageTitle = { id: "settings.runtime.questions.page.title", message: "Waiting for response" }
const questionsPageDesc = {
  id: "settings.runtime.questions.page.desc",
  message: "Choose how long unanswered questions remain open.",
}
const timeoutSectionTitle = { id: "settings.runtime.questions.timeout.title", message: "Timeout" }
const responseRowTitle = settingsFieldCopy.questionResponse
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
const autoCompactRowTitle = settingsFieldCopy.compactionAuto
const autoCompactRowDesc = {
  id: "settings.runtime.compaction.autoCompact.desc",
  message: "Compact sessions when context is full",
}
const pruneRowTitle = { id: "settings.runtime.compaction.prune.title", message: "Prune Tool Output" }
const pruneRowDesc = {
  id: "settings.runtime.compaction.prune.desc",
  message: "Prune old tool outputs during compaction",
}
const overflowRowTitle = settingsFieldCopy.compactionOverflow
const overflowRowDesc = {
  id: "settings.runtime.compaction.overflow.desc",
  message: "Context usage fraction that triggers auto-compaction",
}
const overflowAria = { id: "settings.runtime.compaction.overflowAria", message: "Compaction overflow threshold" }
const maxImagesRowTitle = settingsFieldCopy.compactionImages
const maxImagesRowDesc = {
  id: "settings.runtime.compaction.maxImages.desc",
  message: "Maximum images from earlier messages included in each request",
}
const maxImagesAria = { id: "settings.runtime.compaction.maxImagesAria", message: "Maximum history images" }
const codexRemoteRowTitle = {
  id: "settings.runtime.compaction.codexRemote.title",
  message: "Codex Remote Compaction",
}
const codexRemoteRowDesc = {
  id: "settings.runtime.compaction.codexRemote.desc",
  message: "Ask the Codex backend to compact server-side alongside the local summary (OpenAI Codex sessions only).",
}

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
const agentsPageTitle = { id: "settings.runtime.agents.page.title", message: "Agent runtime" }
const agentsPageDesc = {
  id: "settings.runtime.agents.page.desc",
  message: "Choose the default agent and how much work can run at once.",
}
const agentSectionTitle = { id: "settings.runtime.agents.agent.title", message: "Agent" }
const coauthorRowTitle = settingsFieldCopy.coauthor
const coauthorRowDesc = {
  id: "settings.runtime.agents.coauthor.desc",
  message: "Remind agents to include the Synergy co-author footer when creating git commits.",
}
const defaultAgentRowTitle = settingsFieldCopy.defaultAgent
const defaultAgentRowDesc = {
  id: "settings.runtime.agents.defaultAgent.desc",
  message: "Primary agent for new conversations. Hidden and subagent definitions are excluded.",
}
const agentWorkersRowTitle = settingsFieldCopy.agentWorkers
const agentWorkersRowDesc = {
  id: "settings.runtime.agents.agentWorkers.desc",
  message: "Maximum model requests running at once. Reducing this limit lets active requests finish.",
}
const agentWorkersPlaceholder = {
  id: "settings.runtime.agents.agentWorkers.placeholder",
  message: "Auto",
}
const invokeRowTitle = settingsFieldCopy.invokeTimeout
const invokeRowDesc = {
  id: "settings.runtime.agents.invoke.desc",
  message: "Seconds before a task invoke call times out.",
}
const concurrencyRowTitle = settingsFieldCopy.agentConcurrency
const concurrencyRowDesc = {
  id: "settings.runtime.agents.concurrency.desc",
  message: "Maximum collaborator tasks running at once. New tasks may queue sooner when memory is limited.",
}
const providerSectionTitle = { id: "settings.runtime.agents.provider.title", message: "Provider" }
const ttfbRowTitle = settingsFieldCopy.providerTtfb
const ttfbRowDesc = {
  id: "settings.runtime.agents.ttfb.desc",
  message: "Seconds to wait for the first response byte from a provider.",
}
const idleRowTitle = settingsFieldCopy.providerIdle
const idleRowDesc = {
  id: "settings.runtime.agents.idle.desc",
  message: "Seconds of provider inactivity before the connection is dropped.",
}
const wallRowTitle = settingsFieldCopy.providerWall
const wallRowDesc = {
  id: "settings.runtime.agents.wall.desc",
  message: "Maximum provider call duration in seconds. Leave empty to use the default; zero disables the limit.",
}
const toolsSectionTitle = { id: "settings.runtime.agents.tools.title", message: "Tools" }
const toolTimeoutRowTitle = settingsFieldCopy.toolTimeout
const toolTimeoutRowDesc = {
  id: "settings.runtime.agents.toolTimeout.desc",
  message: "Seconds before a tool execution attempt times out.",
}
const overridesRowTitle = settingsFieldCopy.toolOverrides
const overridesRowDesc = {
  id: "settings.runtime.agents.overrides.desc",
  message: "Per-tool timeout overrides as JSON or key-value pairs.",
}

/* Observability */
const observPageTitle = { id: "settings.runtime.observ.page.title", message: "Diagnostics" }
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
const performanceEnabledRowTitle = {
  id: "settings.runtime.observ.performanceEnabled.title",
  message: "Performance Monitoring",
}
const performanceEnabledRowDesc = {
  id: "settings.runtime.observ.performanceEnabled.desc",
  message:
    "Collect local performance metrics, traces, and diagnostics. Disable to stop all background sampling and writes.",
}
const shellSectionTitle = { id: "settings.runtime.observ.shell.title", message: "Desktop Shell Environment" }
const shellSectionDesc = {
  id: "settings.runtime.observ.shell.desc",
  message: "Environment captured once when the Desktop managed server starts.",
}
const shellSourceLogin = { id: "settings.runtime.observ.shell.source.login", message: "Login shell" }
const shellSourceInherited = { id: "settings.runtime.observ.shell.source.inherited", message: "Desktop process" }
const shellFallbackWarning = {
  id: "settings.runtime.observ.shell.warning",
  message: "The login shell PATH could not be read, so the Desktop process PATH is being used.",
}
const shellPathLabel = { id: "settings.runtime.observ.shell.path", message: "Effective PATH" }
const shellCommandFound = { id: "settings.runtime.observ.shell.command.found", message: "Resolved" }
const shellCommandMissing = { id: "settings.runtime.observ.shell.command.missing", message: "Not found" }

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
  capacityStatus?: AgentWorkerCapacityStatus
  fieldError?: (key: keyof RuntimeStore) => string | undefined
  popoverLayer?: HTMLElement
}) {
  const { _, i18n } = useLingui()
  const environmentConcurrency = () => props.concurrencyStatus?.environment
  const managedByEnvironment = () => environmentConcurrency() !== null && environmentConcurrency() !== undefined
  const displayedConcurrency = () =>
    managedByEnvironment() ? String(environmentConcurrency()) : props.runtime.cortexConcurrency
  const concurrencyStateLabel = () => {
    const pressure = concurrencyPressureState(props.concurrencyStatus)
    if (pressure?.managed) {
      return _({
        id: "settings.runtime.agents.concurrency.memoryLimitManaged",
        message: "Managed by environment · Memory safety limit active: {value}",
        values: { value: pressure.value },
      })
    }
    if (pressure) {
      return _({
        id: "settings.runtime.agents.concurrency.memoryLimit",
        message: "Memory safety limit active: {value}. New tasks will queue until pressure drops.",
        values: { value: pressure.value },
      })
    }
    if (managedByEnvironment()) return _(managedByEnvLabel)
    return undefined
  }

  const agentWorkerStateLabel = () => {
    const display = agentWorkerCapacityDisplay(props.capacityStatus)
    if (!display) return undefined
    if (display.source === "derived") {
      return _({
        id: "settings.runtime.agents.agentWorkers.derived",
        message: "Auto · machine-derived: {value}",
        values: { value: display.value },
      })
    }
    return _({
      id: "settings.runtime.agents.agentWorkers.explicit",
      message: "Configured: {value}",
      values: { value: display.value },
    })
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
            <MenuField
              value={defaultPrimaryAgent(props.defaultAgent, props.availableAgents) ?? ""}
              ariaLabel={_(defaultAgentRowTitle)}
              popoverLayer={props.popoverLayer}
              options={props.availableAgents.map((agent) => ({
                value: agent.name,
                label: translateDescriptor(getAgentVisual(agent).label, i18n()),
              }))}
              onChange={(value) => props.onDefaultAgentChange(value)}
            />
          }
        />
        <SettingRow
          title={_(agentWorkersRowTitle)}
          description={_(agentWorkersRowDesc)}
          stateLabel={agentWorkerStateLabel()}
          trailing={
            <TextField
              type="number"
              min="1"
              max="64"
              step="1"
              value={props.runtime.agentWorkers}
              validationState={props.fieldError?.("agentWorkers") ? "invalid" : "valid"}
              error={props.fieldError?.("agentWorkers")}
              placeholder={_(agentWorkersPlaceholder)}
              class="settings-row-control-text"
              onChange={(value) => props.onRuntimeChange("agentWorkers", value)}
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
              validationState={props.fieldError?.("cortexConcurrency") ? "invalid" : "valid"}
              error={props.fieldError?.("cortexConcurrency")}
              placeholder="8"
              disabled={managedByEnvironment()}
              class="settings-row-control-text"
              onChange={(value) => props.onRuntimeChange("cortexConcurrency", value)}
            />
          }
        />
      </SettingsSection>
      <SettingsAdvanced
        id="timeouts"
        title={_({ id: "settings.runtime.agents.advanced", message: "Service and tool timeouts" })}
        fields={[invokeRowTitle, ttfbRowTitle, idleRowTitle, wallRowTitle, toolTimeoutRowTitle, overridesRowTitle].map(
          (field) => _(field),
        )}
        forceOpen={[
          "invokeTimeout",
          "providerTtfbTimeout",
          "providerIdleTimeout",
          "providerWallTimeout",
          "toolDefaultTimeout",
          "toolOverrides",
        ].some((key) => props.fieldError?.(key as keyof RuntimeStore))}
      >
        <SettingsSection title={_(agentSectionTitle)}>
          <SettingRow
            title={_(invokeRowTitle)}
            description={_(invokeRowDesc)}
            trailing={
              <TextField
                type="number"
                value={props.runtime.invokeTimeout}
                validationState={props.fieldError?.("invokeTimeout") ? "invalid" : "valid"}
                error={props.fieldError?.("invokeTimeout")}
                placeholder="900"
                class="settings-row-control-text"
                onChange={(value) => props.onRuntimeChange("invokeTimeout", value)}
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
                validationState={props.fieldError?.("providerTtfbTimeout") ? "invalid" : "valid"}
                error={props.fieldError?.("providerTtfbTimeout")}
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
                validationState={props.fieldError?.("providerIdleTimeout") ? "invalid" : "valid"}
                error={props.fieldError?.("providerIdleTimeout")}
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
                validationState={props.fieldError?.("providerWallTimeout") ? "invalid" : "valid"}
                error={props.fieldError?.("providerWallTimeout")}
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
                validationState={props.fieldError?.("toolDefaultTimeout") ? "invalid" : "valid"}
                error={props.fieldError?.("toolDefaultTimeout")}
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
                validationState={props.fieldError?.("toolOverrides") ? "invalid" : "valid"}
                error={props.fieldError?.("toolOverrides")}
                placeholder="bash=600\nwebfetch=120"
                class="settings-row-control-text"
                onChange={(value) => props.onRuntimeChange("toolOverrides", value)}
              />
            }
          />
        </SettingsSection>
      </SettingsAdvanced>
    </SettingsPage>
  )
}

export function ObservabilityPanel(props: {
  runtime: RuntimeStore
  shellEnvironment?: DesktopShellEnvironmentDiagnostics | null
  onRuntimeChange: (key: keyof RuntimeStore, value: string) => void
}) {
  const { _ } = useLingui()
  return (
    <SettingsPage title={_(observPageTitle)} description={_(observPageDesc)}>
      <SettingsSection title={_(loggingSectionTitle)}>
        <SettingRow
          title={_(performanceEnabledRowTitle)}
          description={_(performanceEnabledRowDesc)}
          trailing={
            <Switch
              checked={props.runtime.performanceEnabled !== "false"}
              onChange={(value) => props.onRuntimeChange("performanceEnabled", value ? "true" : "false")}
            />
          }
        />
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
      <Show when={props.shellEnvironment}>
        {(environment) => (
          <SettingsAdvanced
            id="environment"
            title={_(shellSectionTitle)}
            fields={[_(shellSectionTitle), _(shellPathLabel)]}
          >
            <SettingsSection title={_(shellSectionTitle)} description={_(shellSectionDesc)}>
              <SettingsPathRow
                label={environment().shell ?? _(shellSourceInherited)}
                path={environment().path}
                status={environment().source === "login-shell" ? _(shellSourceLogin) : _(shellSourceInherited)}
                description={environment().warning ? _(shellFallbackWarning) : _(shellPathLabel)}
              />
              <For each={environment().commands}>
                {(command) => (
                  <SettingRow
                    title={command.command}
                    description={command.path ?? _(shellCommandMissing)}
                    stateLabel={command.path ? _(shellCommandFound) : _(shellCommandMissing)}
                    trailing={<span />}
                  />
                )}
              </For>
            </SettingsSection>
          </SettingsAdvanced>
        )}
      </Show>
    </SettingsPage>
  )
}
