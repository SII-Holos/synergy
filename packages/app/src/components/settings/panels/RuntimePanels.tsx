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
}) {
  return (
    <SettingsPage title="Timeouts" description="Agent, provider, and tool timeout controls.">
      <SettingsSection title="Agent">
        <SettingsFieldGrid>
          <TextField
            label="Invoke Timeout"
            type="number"
            value={props.runtime.invokeTimeout}
            placeholder="900"
            description="Max wall-clock seconds for one agent turn."
            onChange={(value) => props.onRuntimeChange("invokeTimeout", value)}
          />
        </SettingsFieldGrid>
      </SettingsSection>
      <SettingsSection title="Provider">
        <SettingsFieldGrid>
          <TextField
            label="TTFB Timeout"
            type="number"
            value={props.runtime.providerTtfbTimeout}
            placeholder="600"
            onChange={(value) => props.onRuntimeChange("providerTtfbTimeout", value)}
          />
          <TextField
            label="Idle Timeout"
            type="number"
            value={props.runtime.providerIdleTimeout}
            placeholder="180"
            onChange={(value) => props.onRuntimeChange("providerIdleTimeout", value)}
          />
          <TextField
            label="Wall Timeout"
            type="number"
            value={props.runtime.providerWallTimeout}
            placeholder="0"
            onChange={(value) => props.onRuntimeChange("providerWallTimeout", value)}
          />
        </SettingsFieldGrid>
      </SettingsSection>
      <SettingsSection title="Tools">
        <SettingsFieldGrid>
          <TextField
            label="Default Tool Timeout"
            type="number"
            value={props.runtime.toolDefaultTimeout}
            placeholder="300"
            onChange={(value) => props.onRuntimeChange("toolDefaultTimeout", value)}
          />
          <TextField
            label="Tool Overrides"
            multiline
            value={props.runtime.toolOverrides}
            placeholder={"bash=600\nwebfetch=120"}
            onChange={(value) => props.onRuntimeChange("toolOverrides", value)}
          />
        </SettingsFieldGrid>
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
        <SettingsFieldGrid>
          <TextField
            label="Log Level"
            type="text"
            value={props.runtime.logLevel}
            placeholder="info"
            onChange={(value) => props.onRuntimeChange("logLevel", value)}
          />
          <TextField
            label="Watcher Ignore"
            multiline
            value={props.runtime.watcherIgnore}
            placeholder={"node_modules\n.git"}
            description="One ignore pattern per line."
            onChange={(value) => props.onRuntimeChange("watcherIgnore", value)}
          />
        </SettingsFieldGrid>
      </SettingsSection>
    </SettingsPage>
  )
}
