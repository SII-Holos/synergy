import { useLingui } from "@lingui/solid"
import { For } from "solid-js"
import type { ControlProfileSummary, SandboxStatus } from "@ericsanchezok/synergy-sdk/client"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { SettingRow } from "../components/SettingRow"
import { SettingsStepScale } from "../components/SettingsStepScale"
import { SettingsPage, SettingsSection } from "../components/SettingsPrimitives"
import type { SafetyStore } from "../types"

const sandboxChecking = { id: "settings.sandbox.checking", message: "Checking sandbox status..." }

function sandboxNotSupportedText(platform: string) {
  return {
    id: "settings.sandbox.notSupported",
    message: "Sandbox is not supported on {platform}. Permission gates still apply.",
    values: { platform },
  }
}
function sandboxUnavailableText(backend: string) {
  return {
    id: "settings.sandbox.unavailable",
    message: "{backend} is unavailable. Fallback policy will apply.",
    values: { backend },
  }
}
function sandboxAvailableText(backend: string, platform: string) {
  return {
    id: "settings.sandbox.available",
    message: "{backend} is available on {platform}.",
    values: { backend, platform },
  }
}

/* permission */
const permPageTitle = { id: "settings.permissions.page.title", message: "Permissions" }
const permPageDesc = {
  id: "settings.permissions.page.desc",
  message: "Default permission mode and smart allow policy.",
}
const permSectionTitle = { id: "settings.permissions.section.title", message: "Default Mode" }
const permModeRowTitle = { id: "settings.permissions.modeRow.title", message: "Permission Mode" }
const permModeRowDesc = {
  id: "settings.permissions.modeRow.desc",
  message: "Default permission behavior when no narrower tool rule applies",
}
const permModeAria = { id: "settings.permissions.modeAria", message: "Permission mode" }
const smartAllowRowTitle = { id: "settings.permissions.smartAllow.title", message: "Smart Allow" }
const smartAllowRowDesc = {
  id: "settings.permissions.smartAllow.desc",
  message: "Use an internal agent to auto-allow safe asks and soft denies",
}
const askLabel = { id: "settings.permissions.ask", message: "Ask" }
const allowLabel = { id: "settings.permissions.allow", message: "Allow" }
const denyLabel = { id: "settings.permissions.deny", message: "Deny" }

/* sandbox */
const sandboxPageTitle = { id: "settings.sandbox.page.title", message: "Sandbox" }
const sandboxPageDesc = { id: "settings.sandbox.page.desc", message: "Sandbox backend status and fallback behavior." }
const sandboxSectionTitle = { id: "settings.sandbox.section.title", message: "Runtime Boundary" }
const sandboxEnabledRowTitle = { id: "settings.sandbox.enabled.title", message: "Enabled" }
const sandboxEnabledRowDesc = {
  id: "settings.sandbox.enabled.desc",
  message: "Use the sandbox runtime when it is available",
}
const sandboxFallbackRowTitle = { id: "settings.sandbox.fallback.title", message: "Fallback Policy" }
const sandboxFallbackRowDesc = {
  id: "settings.sandbox.fallback.desc",
  message: "How to proceed when sandbox enforcement is unavailable",
}
const sandboxFallbackAria = { id: "settings.sandbox.fallbackAria", message: "Sandbox fallback policy" }
const warnLabel = { id: "settings.sandbox.warn", message: "Warn" }

/* control profile */
const profilePageTitle = { id: "settings.controlProfile.page.title", message: "Control Profile" }
const profilePageDesc = {
  id: "settings.controlProfile.page.desc",
  message: "Resolved access profile applied to sessions and agents.",
}

const fallbackProfiles: ControlProfileSummary[] = [
  {
    id: "guarded",
    label: "Guarded",
    description:
      "Auto-allow reads, safe local edits, and network lookups. Ask before shell, external writes, identity, platform, or extension actions.",
  },
  {
    id: "autonomous",
    label: "Autonomous",
    description:
      "Keep working unattended. Medium-risk work is allowed; high-risk asks are denied instead of prompting.",
  },
  { id: "full_access", label: "Full Access", description: "Allow all local tool requests without approval prompts." },
]

export function PermissionsPanel(props: {
  safety: SafetyStore
  onSafetyChange: (key: keyof SafetyStore, value: string) => void
}) {
  const { _ } = useLingui()
  return (
    <SettingsPage title={_(permPageTitle)} description={_(permPageDesc)}>
      <SettingsSection title={_(permSectionTitle)}>
        <SettingRow
          title={_(permModeRowTitle)}
          description={_(permModeRowDesc)}
          trailing={
            <SettingsStepScale
              value={props.safety.permission}
              ariaLabel={_(permModeAria)}
              options={[
                { value: "ask", label: _(askLabel) },
                { value: "allow", label: _(allowLabel) },
                { value: "deny", label: _(denyLabel) },
              ]}
              onChange={(value) => props.onSafetyChange("permission", value)}
            />
          }
        />
        <SettingRow
          title={_(smartAllowRowTitle)}
          description={_(smartAllowRowDesc)}
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
  const { _ } = useLingui()
  return (
    <SettingsPage title={_(sandboxPageTitle)} description={_(sandboxPageDesc)}>
      <SettingsSection title={_(sandboxSectionTitle)}>
        <SettingRow
          title={_(sandboxEnabledRowTitle)}
          description={_(sandboxEnabledRowDesc)}
          trailing={
            <Switch
              checked={props.safety.sandboxEnabled !== "false"}
              onChange={(value) => props.onSafetyChange("sandboxEnabled", value ? "true" : "false")}
            />
          }
        />
        <SettingRow
          title={_(sandboxFallbackRowTitle)}
          description={_(sandboxFallbackRowDesc)}
          trailing={
            <SettingsStepScale
              value={props.safety.sandboxFallbackPolicy}
              ariaLabel={_(sandboxFallbackAria)}
              options={[
                { value: "warn", label: _(warnLabel) },
                { value: "allow", label: _(allowLabel) },
                { value: "deny", label: _(denyLabel) },
              ]}
              onChange={(value) => props.onSafetyChange("sandboxFallbackPolicy", value)}
            />
          }
        />
        <div class="ds-sandbox-status" classList={{ "ds-sandbox-status-ok": props.sandboxStatus?.available === true }}>
          {sandboxLabelText(props.sandboxStatus, _)}
        </div>
      </SettingsSection>
    </SettingsPage>
  )
}

function sandboxLabelText(s: SandboxStatus | undefined, _: ReturnType<typeof useLingui>["_"]) {
  if (!s) return _(sandboxChecking)
  if (!s.supported) return _(sandboxNotSupportedText(s.platform))
  if (!s.available) return _(sandboxUnavailableText(s.backend ?? "Sandbox"))
  return _(sandboxAvailableText(s.backend ?? "Sandbox", s.platform))
}

export function ControlProfilePanel(props: {
  safety: SafetyStore
  controlProfiles: ControlProfileSummary[]
  onSafetyChange: (key: keyof SafetyStore, value: string) => void
}) {
  const { _ } = useLingui()
  const profiles = () => (props.controlProfiles.length ? props.controlProfiles : fallbackProfiles)
  return (
    <SettingsPage title={_(profilePageTitle)} description={_(profilePageDesc)}>
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
