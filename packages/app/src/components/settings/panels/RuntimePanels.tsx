import type { Agent } from "@ericsanchezok/synergy-sdk/client"
import { For } from "solid-js"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { SettingRow } from "../components/SettingRow"
import { SettingsStepScale } from "../components/SettingsStepScale"
import { SettingsFieldGrid, SettingsPage, SettingsSection } from "../components/SettingsPrimitives"
import type { RuntimeStore } from "../types"

export function QuestionsPanel(props: {
  runtime: RuntimeStore
  onRuntimeChange: (key: keyof RuntimeStore, value: string) => void
}) {
  return (
    <SettingsPage title="Questions" description="Question timeout behavior.">
      <SettingsSection title="Timeout">
        <SettingRow
          title="Response Timeout"
          description="Auto-expire unanswered questions"
          trailing={
            <SettingsStepScale
              value={props.runtime.questionTimeout}
              ariaLabel="Question response timeout"
              options={[
                { value: "0", label: "Never" },
                { value: "300", label: "5 min" },
                { value: "600", label: "10 min" },
                { value: "1800", label: "30 min" },
                { value: "3600", label: "60 min" },
              ]}
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
  return (
    <SettingsPage title="Compaction" description="Session compaction and history limits.">
      <SettingsSection title="Context Management">
        <SettingRow
          title="Auto Compact"
          description="Compact sessions when context is full"
          trailing={
            <Switch
              checked={props.runtime.compactionAuto !== "false"}
              onChange={(value) => props.onRuntimeChange("compactionAuto", value ? "true" : "false")}
            />
          }
        />
        <SettingRow
          title="Prune Tool Output"
          description="Prune old tool outputs during compaction"
          trailing={
            <Switch
              checked={props.runtime.compactionPrune !== "false"}
              onChange={(value) => props.onRuntimeChange("compactionPrune", value ? "true" : "false")}
            />
          }
        />
        <SettingRow
          title="Overflow Threshold"
          description="Context usage fraction that triggers auto-compaction"
          trailing={
            <SettingsStepScale
              value={props.runtime.compactionOverflowThreshold}
              ariaLabel="Compaction overflow threshold"
              options={[
                { value: "0.70", label: "70%" },
                { value: "0.80", label: "80%" },
                { value: "0.85", label: "85%" },
                { value: "0.90", label: "90%" },
                { value: "0.95", label: "95%" },
              ]}
              onChange={(value) => props.onRuntimeChange("compactionOverflowThreshold", value)}
            />
          }
        />
        <SettingRow
          title="Max History Images"
          description="Maximum historical images sent as base64 per request"
          trailing={
            <SettingsStepScale
              value={props.runtime.compactionMaxHistoryImages}
              ariaLabel="Maximum history images"
              options={[
                { value: "0", label: "0" },
                { value: "4", label: "4" },
                { value: "8", label: "8" },
                { value: "12", label: "12" },
                { value: "16", label: "16" },
              ]}
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
}) {
  return (
    <SettingsPage title="Timeouts" description="Agent, provider, and tool timeout controls.">
      <SettingsSection title="Agent">
        <SettingRow
          title="Default Agent"
          description="Primary agent for new conversations. Hidden and subagent definitions are excluded."
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
          title="Invoke Timeout"
          description="Milliseconds before a task invoke call times out."
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
      </SettingsSection>
      <SettingsSection title="Provider">
        <SettingRow
          title="TTFB Timeout"
          description="Milliseconds to wait for the first response byte from a provider."
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
          title="Idle Timeout"
          description="Milliseconds of provider inactivity before the connection is dropped."
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
          title="Wall Timeout"
          description="Hard cap in milliseconds for the total provider call duration."
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
      <SettingsSection title="Tools">
        <SettingRow
          title="Default Tool Timeout"
          description="Milliseconds before a tool execution attempt times out."
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
          title="Tool Overrides"
          description="Per-tool timeout overrides as JSON or key-value pairs."
          trailing={
            <TextField
              type="text"
              multiline
              value={props.runtime.toolOverrides}
              placeholder={"bash=600\nwebfetch=120"}
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
  return (
    <SettingsPage title="Observability" description="Logs, traces, and diagnostics.">
      <SettingsSection title="Logging">
        <SettingRow
          title="Log Level"
          description="Minimum log severity captured by the runtime logger."
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
          title="Watcher Ignore"
          description="Patterns the file watcher should skip, one per line."
          trailing={
            <TextField
              type="text"
              multiline
              value={props.runtime.watcherIgnore}
              placeholder={"node_modules\n.git"}
              class="settings-row-control-text"
              onChange={(value) => props.onRuntimeChange("watcherIgnore", value)}
            />
          }
        />
      </SettingsSection>
    </SettingsPage>
  )
}
