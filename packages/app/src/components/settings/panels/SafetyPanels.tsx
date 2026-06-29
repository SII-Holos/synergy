import { For } from "solid-js"
import type { ControlProfileSummary, SandboxStatus } from "@ericsanchezok/synergy-sdk/client"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { SettingRow } from "../components/SettingRow"
import { SettingsStepScale } from "../components/SettingsStepScale"
import { SettingsPage, SettingsSection } from "../components/SettingsPrimitives"
import type { SafetyStore } from "../types"

const fallbackProfiles: ControlProfileSummary[] = [
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

export function PermissionsPanel(props: {
  safety: SafetyStore
  onSafetyChange: (key: keyof SafetyStore, value: string) => void
}) {
  return (
    <SettingsPage title="Permissions" description="Default permission mode and smart allow policy.">
      <SettingsSection title="Default Mode">
        <SettingRow
          title="Permission Mode"
          description="Default permission behavior when no narrower tool rule applies"
          trailing={
            <SettingsStepScale
              value={props.safety.permission}
              ariaLabel="Permission mode"
              options={[
                { value: "ask", label: "Ask" },
                { value: "allow", label: "Allow" },
                { value: "deny", label: "Deny" },
              ]}
              onChange={(value) => props.onSafetyChange("permission", value)}
            />
          }
        />
        <SettingRow
          title="Smart Allow"
          description="Use an internal agent to auto-allow safe asks and soft denies"
          trailing={
            <Switch
              checked={props.safety.smartAllow !== "false"}
              onChange={(value) => props.onSafetyChange("smartAllow", value ? "true" : "false")}
            />
          }
        />
      </SettingsSection>
    </SettingsPage>
  )
}

export function SandboxPanel(props: {
  safety: SafetyStore
  sandboxStatus?: SandboxStatus
  onSafetyChange: (key: keyof SafetyStore, value: string) => void
}) {
  return (
    <SettingsPage title="Sandbox" description="Sandbox backend status and fallback behavior.">
      <SettingsSection title="Runtime Boundary">
        <SettingRow
          title="Enabled"
          description="Use the sandbox runtime when it is available"
          trailing={
            <Switch
              checked={props.safety.sandboxEnabled !== "false"}
              onChange={(value) => props.onSafetyChange("sandboxEnabled", value ? "true" : "false")}
            />
          }
        />
        <SettingRow
          title="Fallback Policy"
          description="How to proceed when sandbox enforcement is unavailable"
          trailing={
            <SettingsStepScale
              value={props.safety.sandboxFallbackPolicy}
              ariaLabel="Sandbox fallback policy"
              options={[
                { value: "warn", label: "Warn" },
                { value: "allow", label: "Allow" },
                { value: "deny", label: "Deny" },
              ]}
              onChange={(value) => props.onSafetyChange("sandboxFallbackPolicy", value)}
            />
          }
        />
        <div class="ds-sandbox-status" classList={{ "ds-sandbox-status-ok": props.sandboxStatus?.available === true }}>
          {sandboxLabel(props.sandboxStatus)}
        </div>
      </SettingsSection>
    </SettingsPage>
  )
}

export function ControlProfilePanel(props: {
  safety: SafetyStore
  controlProfiles: ControlProfileSummary[]
  onSafetyChange: (key: keyof SafetyStore, value: string) => void
}) {
  const profiles = () => (props.controlProfiles.length ? props.controlProfiles : fallbackProfiles)
  return (
    <SettingsPage title="Control Profile" description="Resolved access profile applied to sessions and agents.">
      <SettingsSection>
        <div class="ds-profile-grid">
          <For each={profiles()}>
            {(profile) => (
              <button
                type="button"
                class="ds-profile-card"
                classList={{ "ds-profile-card-active": props.safety.controlProfile === profile.id }}
                onClick={() => props.onSafetyChange("controlProfile", profile.id)}
              >
                <span class="ds-profile-name">{profile.label}</span>
                <span class="ds-profile-description">{profileDescription(profile)}</span>
              </button>
            )}
          </For>
        </div>
      </SettingsSection>
    </SettingsPage>
  )
}

function profileDescription(profile: ControlProfileSummary) {
  return fallbackProfiles.find((item) => item.id === profile.id)?.description ?? profile.description
}

function sandboxLabel(status: SandboxStatus | undefined) {
  if (!status) return "Checking sandbox status..."
  if (!status.supported) return `Sandbox is not supported on ${status.platform}. Permission gates still apply.`
  if (!status.available) return `${status.backend ?? "Sandbox"} is unavailable. Fallback policy will apply.`
  return `${status.backend ?? "Sandbox"} is available on ${status.platform}.`
}
