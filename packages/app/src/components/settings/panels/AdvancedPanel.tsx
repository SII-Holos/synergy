import { SettingRow } from "../components/SettingRow"
import { SectionLabel } from "../components/SectionLabel"
import { SegmentPill } from "../components/SegmentPill"
import type { AdvancedStore } from "../types"

export function AdvancedPanel(props: {
  advanced: AdvancedStore
  onAdvancedChange: (key: keyof AdvancedStore, value: string) => void
}) {
  return (
    <div class="ds-content-inner">
      <h1 class="ds-content-title">System</h1>

      <div class="ds-setting-section">
        <SectionLabel title="Permission" />
        <SettingRow
          title="Default Mode"
          description="How tool permission requests are handled"
          trailing={
            <SegmentPill
              value={props.advanced.permission}
              options={[
                { value: "allow", label: "Allow" },
                { value: "ask", label: "Ask" },
                { value: "deny", label: "Deny" },
              ]}
              onChange={(value) => props.onAdvancedChange("permission", value)}
              showReset
              defaultValue="ask"
              onReset={() => props.onAdvancedChange("permission", "ask")}
            />
          }
        />
      </div>

      <div class="ds-setting-section">
        <SectionLabel title="Question" />
        <SettingRow
          title="Response Timeout"
          description="Auto-expire unanswered questions (0 = no timeout, default 30min)"
          trailing={
            <SegmentPill
              value={props.advanced.question_timeout}
              options={[
                { value: "0", label: "Never" },
                { value: "300", label: "5min" },
                { value: "600", label: "10min" },
                { value: "1800", label: "30min" },
                { value: "3600", label: "60min" },
              ]}
              onChange={(value) => props.onAdvancedChange("question_timeout", value)}
              showReset
              defaultValue="1800"
              onReset={() => props.onAdvancedChange("question_timeout", "1800")}
            />
          }
        />
      </div>

      <div class="ds-setting-section">
        <SectionLabel title="Compaction" />
        <SettingRow
          title="Auto Compact"
          description="Compact sessions when context is full"
          trailing={
            <SegmentPill
              value={props.advanced.compaction_auto}
              options={[
                { value: "true", label: "On" },
                { value: "false", label: "Off" },
              ]}
              onChange={(value) => props.onAdvancedChange("compaction_auto", value)}
              showReset
              defaultValue="true"
              onReset={() => props.onAdvancedChange("compaction_auto", "true")}
            />
          }
        />
        <SettingRow
          title="Overflow Threshold"
          description="Context usage fraction that triggers auto-compaction (0.5–1.0, default 0.85)"
          trailing={
            <SegmentPill
              value={props.advanced.compaction_overflow_threshold}
              options={[
                { value: "0.70", label: "70%" },
                { value: "0.80", label: "80%" },
                { value: "0.85", label: "85%" },
                { value: "0.90", label: "90%" },
                { value: "0.95", label: "95%" },
              ]}
              onChange={(value) => props.onAdvancedChange("compaction_overflow_threshold", value)}
              showReset
              defaultValue="0.85"
              onReset={() => props.onAdvancedChange("compaction_overflow_threshold", "0.85")}
            />
          }
        />
      </div>
    </div>
  )
}
