import { For } from "solid-js"
import { SettingRow } from "../components/SettingRow"
import { SectionLabel } from "../components/SectionLabel"
import { SegmentPill } from "../components/SegmentPill"
import type { AdvancedStore } from "../types"
import type { ControlProfileSummary, SandboxStatus } from "@ericsanchezok/synergy-sdk/client"

const FALLBACK_PROFILES: ControlProfileSummary[] = [
  {
    id: "guarded",
    label: "Guarded",
    description:
      "Auto-allow safe local edits and network lookups. Ask before shell, external, identity, platform, or extension actions.",
  },
  {
    id: "autonomous",
    label: "Autonomous",
    description: "Keep working unattended. High-risk actions are denied instead of prompting.",
  },
  {
    id: "full_access",
    label: "Full Access",
    description: "Allow all local tool requests without approval prompts.",
  },
]

function profileDescription(profile: ControlProfileSummary) {
  return FALLBACK_PROFILES.find((item) => item.id === profile.id)?.description ?? profile.description
}

function sandboxLabel(status: SandboxStatus | undefined) {
  if (!status) return "Checking sandbox status..."
  if (!status.supported) return `Sandbox is not supported on ${status.platform}. Permission gates still apply.`
  if (!status.available) return `${status.backend ?? "Sandbox"} is unavailable. Fallback policy will apply.`
  return `${status.backend ?? "Sandbox"} is available on ${status.platform}.`
}

export function AdvancedPanel(props: {
  advanced: AdvancedStore
  controlProfiles: ControlProfileSummary[]
  sandboxStatus?: SandboxStatus
  onAdvancedChange: (key: keyof AdvancedStore, value: string) => void
}) {
  const profiles = () => (props.controlProfiles.length ? props.controlProfiles : FALLBACK_PROFILES)
  return (
    <div class="ds-content-inner">
      <h1 class="ds-content-title">System</h1>

      <div class="ds-setting-section">
        <SectionLabel title="Control profile" />
        <div class="ds-profile-grid">
          <For each={profiles()}>
            {(profile) => (
              <button
                type="button"
                class="ds-profile-card"
                classList={{ "ds-profile-card-active": props.advanced.controlProfile === profile.id }}
                onClick={() => props.onAdvancedChange("controlProfile", profile.id)}
              >
                <span class="ds-profile-name">{profile.label}</span>
                <span class="ds-profile-description">{profileDescription(profile)}</span>
              </button>
            )}
          </For>
        </div>
        <div class="ds-sandbox-status" classList={{ "ds-sandbox-status-ok": props.sandboxStatus?.available === true }}>
          {sandboxLabel(props.sandboxStatus)}
        </div>
      </div>

      <div class="ds-setting-section">
        <SectionLabel title="Permission" />
        <SettingRow
          title="Smart allow"
          description="Use an internal agent to auto-allow safe asks and soft denies. Hard safety boundaries remain blocked; Autonomous never prompts."
          trailing={
            <SegmentPill
              value={props.advanced.smartAllow}
              options={[
                { value: "false", label: "Off" },
                { value: "true", label: "On" },
              ]}
              onChange={(value) => props.onAdvancedChange("smartAllow", value)}
              showReset
              defaultValue="false"
              onReset={() => props.onAdvancedChange("smartAllow", "false")}
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
