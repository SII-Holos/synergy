import { For } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon, type SemanticIconTokenName } from "@ericsanchezok/synergy-ui/semantic-icon"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { useTheme, type ColorScheme } from "@ericsanchezok/synergy-ui/theme"
import { SettingRow } from "../components/SettingRow"
import { SettingsStepScale } from "../components/SettingsStepScale"
import { SettingsPage, SettingsSection } from "../components/SettingsPrimitives"
import {
  DEFAULT_TOAST_DURATION_MS,
  TOAST_DURATION_STOPS,
  TOAST_TYPES,
  snapToastDuration,
  type GeneralStore,
  type ToastType,
} from "../types"

const colorSchemeOptions: Array<{
  value: ColorScheme
  label: string
  description: string
  iconToken: SemanticIconTokenName
}> = [
  { value: "light", label: "Light", description: "Bright surfaces", iconToken: "settings.colorLight" },
  { value: "dark", label: "Dark", description: "Dimmed surfaces", iconToken: "settings.colorDark" },
  { value: "system", label: "Auto", description: "Follow this device", iconToken: "settings.colorSystem" },
]

const toastCopy: Record<ToastType, { label: string; description: string }> = {
  info: { label: "Info", description: "General notices and background updates" },
  success: { label: "Success", description: "Completed actions and saved changes" },
  warning: { label: "Warning", description: "Attention needed, without blocking work" },
  error: { label: "Error", description: "Failures and blocked actions" },
}

export function GeneralPanel(props: {
  general: GeneralStore
  onGeneralChange: <K extends keyof GeneralStore>(key: K, value: GeneralStore[K]) => void
}) {
  const theme = useTheme()

  function toggleMutedToast(type: ToastType, enabled: boolean) {
    const next = enabled
      ? [...props.general.mutedToasts, type]
      : props.general.mutedToasts.filter((item) => item !== type)
    props.onGeneralChange("mutedToasts", Array.from(new Set(next)))
  }

  function setToastDuration(type: ToastType, value: string) {
    props.onGeneralChange("toastDurations", {
      ...props.general.toastDurations,
      [type]: value,
    })
  }

  return (
    <SettingsPage title="General" description="Appearance, behavior, and notification preferences.">
      <SettingsSection title="Appearance">
        <div class="settings-color-grid" role="radiogroup" aria-label="Color scheme">
          <For each={colorSchemeOptions}>
            {(option) => (
              <button
                type="button"
                role="radio"
                aria-checked={theme.colorScheme() === option.value}
                class="settings-color-card"
                classList={{ "settings-color-card-active": theme.colorScheme() === option.value }}
                onClick={() => theme.setColorScheme(option.value)}
              >
                <span class="settings-color-icon">
                  <Icon name={getSemanticIcon(option.iconToken)} size="normal" />
                </span>
                <span class="settings-color-label">{option.label}</span>
                <span class="settings-color-description">{option.description}</span>
              </button>
            )}
          </For>
        </div>
      </SettingsSection>

      <SettingsSection title="Behavior">
        <SettingRow
          title="File snapshots"
          description="Keep restore points when Synergy edits files"
          trailing={
            <Switch checked={props.general.snapshot} onChange={(value) => props.onGeneralChange("snapshot", value)} />
          }
        />
        <SettingRow
          title="Product updates"
          description="Choose how Synergy handles available updates"
          trailing={
            <SettingsStepScale
              value={props.general.autoupdate}
              ariaLabel="Product update handling"
              options={[
                { value: "true", label: "On" },
                { value: "false", label: "Off" },
                { value: "notify", label: "Notify" },
              ]}
              onChange={(value) => props.onGeneralChange("autoupdate", value)}
            />
          }
        />
      </SettingsSection>

      <SettingsSection
        title="Notifications"
        description="Tune which toast cards appear and how long they stay visible."
      >
        <div class="settings-toast-list">
          <For each={TOAST_TYPES}>
            {(type) => (
              <ToastPreferenceRow
                type={type}
                muted={props.general.mutedToasts.includes(type)}
                duration={props.general.toastDurations[type]}
                onMutedChange={(value) => toggleMutedToast(type, value)}
                onDurationChange={(value) => setToastDuration(type, value)}
              />
            )}
          </For>
        </div>
      </SettingsSection>
    </SettingsPage>
  )
}

function ToastPreferenceRow(props: {
  type: ToastType
  muted: boolean
  duration: string
  onMutedChange: (value: boolean) => void
  onDurationChange: (value: string) => void
}) {
  const copy = () => toastCopy[props.type]
  const duration = () => {
    const parsed = Number(props.duration)
    return Number.isFinite(parsed) && parsed > 0 ? snapToastDuration(parsed) : DEFAULT_TOAST_DURATION_MS
  }
  const hasOverride = () => props.duration.trim().length > 0
  const durationIndex = () => nearestDurationIndex(duration())

  return (
    <div class="settings-toast-row">
      <div class="settings-toast-copy">
        <span class="settings-toast-title">{copy().label}</span>
        <span class="settings-toast-description">{copy().description}</span>
      </div>

      <div class="settings-toast-controls">
        <label class="settings-muted-toggle">
          <span>Mute</span>
          <Switch checked={props.muted} hideLabel onChange={props.onMutedChange}>
            Mute {copy().label}
          </Switch>
        </label>

        <div class="settings-duration-control">
          <div class="settings-duration-header">
            <span>
              {hasOverride() ? `${formatSeconds(duration())}` : `Default ${formatSeconds(DEFAULT_TOAST_DURATION_MS)}`}
            </span>
          </div>
          <input
            class="settings-duration-slider"
            type="range"
            min="0"
            max={String(TOAST_DURATION_STOPS.length - 1)}
            step="1"
            value={durationIndex()}
            aria-label={`${copy().label} toast duration`}
            onInput={(event) => {
              const index = Number(event.currentTarget.value)
              const next = TOAST_DURATION_STOPS[index] ?? TOAST_DURATION_STOPS[0]
              props.onDurationChange(next === DEFAULT_TOAST_DURATION_MS ? "" : String(next))
            }}
          />
          <div class="settings-duration-ticks" aria-hidden="true">
            <For each={TOAST_DURATION_STOPS}>{(stop) => <span>{formatSeconds(stop)}</span>}</For>
          </div>
        </div>
      </div>
    </div>
  )
}

function nearestDurationIndex(value: number): number {
  const snapped = snapToastDuration(value)
  let bestIndex = 0
  let bestDistance = Number.POSITIVE_INFINITY
  for (let index = 0; index < TOAST_DURATION_STOPS.length; index++) {
    const distance = Math.abs(TOAST_DURATION_STOPS[index] - snapped)
    if (distance < bestDistance) {
      bestDistance = distance
      bestIndex = index
    }
  }
  return bestIndex
}

function formatSeconds(value: number): string {
  return `${value / 1000}s`
}
