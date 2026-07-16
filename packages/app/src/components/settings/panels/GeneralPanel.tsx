import { For, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { setToastConfig, showToast } from "@ericsanchezok/synergy-ui/toast"
import { useTheme } from "@ericsanchezok/synergy-ui/theme"
import { useProductUpdate } from "@/context/product-update"
import { useLocale, type LocalePreference } from "@/context/locale"
import { translateDescriptor } from "@/locales/translate"
import type { DesktopUpdateMode } from "@/context/platform"
import { SettingRow } from "../components/SettingRow"
import { SegmentPill } from "../components/SegmentPill"
import { SettingsPage, SettingsSection } from "../components/SettingsPrimitives"
import {
  desktopUpdateStatusCopy,
  downloadLabel,
  serverUpdateActionState,
  serverUpdateStatusCopy,
  webVersionStatus,
} from "./product-update-logic"
import {
  DEFAULT_TOAST_DURATION_MS,
  TOAST_DURATION_STOPS,
  TOAST_TYPES,
  snapToastDuration,
  type GeneralStore,
  type ToastType,
} from "../types"
import { nextMutedToasts, toastConfigFromPreferences } from "../toast-preferences"
import { applyLocalePreference } from "./locale-preference-change"
import { LANGUAGE_SELF_NAMES } from "./language-self-names"

const copy = {
  pageTitle: { id: "settings.general.page.title", message: "General" },
  pageDescription: {
    id: "settings.general.page.description",
    message: "Appearance, behavior, and notification preferences.",
  },
  appearanceTitle: { id: "settings.general.appearance.title", message: "Appearance" },
  themeTitle: { id: "settings.general.theme.title", message: "Theme" },
  themeDescription: {
    id: "settings.general.theme.description",
    message: "Select the active Synergy visual theme",
  },
  colorSchemeLabel: { id: "settings.general.colorScheme.label", message: "Color scheme" },
  colorLight: { id: "settings.general.colorScheme.light", message: "Light" },
  colorLightDescription: { id: "settings.general.colorScheme.light.description", message: "Bright surfaces" },
  colorDark: { id: "settings.general.colorScheme.dark", message: "Dark" },
  colorDarkDescription: { id: "settings.general.colorScheme.dark.description", message: "Dimmed surfaces" },
  colorSystem: { id: "settings.general.colorScheme.system", message: "Auto" },
  colorSystemDescription: {
    id: "settings.general.colorScheme.system.description",
    message: "Follow this device",
  },
  languageTitle: { id: "settings.general.language.title", message: "Interface language" },
  languageDescription: {
    id: "settings.general.language.description",
    message: "Choose the language used by Synergy controls and accessibility labels",
  },
  languageSystem: { id: "settings.general.language.system", message: "Follow System" },
  languageFailedTitle: { id: "settings.general.language.failed.title", message: "Language change failed" },
  languageFailedDescription: {
    id: "settings.general.language.failed.description",
    message: "The selected language catalog could not be loaded. The previous language is still active.",
  },
  behaviorTitle: { id: "settings.general.behavior.title", message: "Behavior" },
  snapshotsTitle: { id: "settings.general.snapshots.title", message: "File snapshots" },
  snapshotsDescription: {
    id: "settings.general.snapshots.description",
    message: "Keep restore points when Synergy edits files",
  },
  notificationsTitle: { id: "settings.general.notifications.title", message: "Notifications" },
  notificationsDescription: {
    id: "settings.general.notifications.description",
    message: "Tune which toast cards appear and how long they stay visible.",
  },
  productUpdatesTitle: { id: "settings.general.updates.title", message: "Product updates" },
  productUpdatesDevelopment: {
    id: "settings.general.updates.development.description",
    message: "Vite keeps this browser current during source development.",
  },
  productUpdatesWeb: {
    id: "settings.general.updates.web.description",
    message: "Refresh this browser when the server has newer Web assets.",
  },
  productUpdatesDesktop: {
    id: "settings.general.updates.desktop.description",
    message: "Keep the desktop app and bundled server runtime current.",
  },
  refreshToUpdate: { id: "settings.general.updates.refresh", message: "Refresh to Update" },
  checking: { id: "settings.general.updates.checking", message: "Checking..." },
  checkVersion: { id: "settings.general.updates.checkVersion", message: "Check Version" },
  modeAuto: { id: "settings.general.updates.mode.auto", message: "Auto" },
  modeNotify: { id: "settings.general.updates.mode.notify", message: "Notify" },
  modeManual: { id: "settings.general.updates.mode.manual", message: "Manual" },
  modeOff: { id: "settings.general.updates.mode.off", message: "Off" },
  checkServer: { id: "settings.general.updates.checkServer", message: "Check Server" },
  reconnecting: { id: "settings.general.updates.reconnecting", message: "Reconnecting..." },
  updateService: { id: "settings.general.updates.updateService", message: "Update Synergy Service" },
  checkNow: { id: "settings.general.updates.checkNow", message: "Check now" },
  download: { id: "settings.general.updates.download", message: "Download" },
  restartToUpdate: { id: "settings.general.updates.restart", message: "Restart to Update" },
  toastInfo: { id: "settings.general.toast.info", message: "Info" },
  toastInfoDescription: {
    id: "settings.general.toast.info.description",
    message: "General notices and background updates",
  },
  toastSuccess: { id: "settings.general.toast.success", message: "Success" },
  toastSuccessDescription: {
    id: "settings.general.toast.success.description",
    message: "Completed actions and saved changes",
  },
  toastWarning: { id: "settings.general.toast.warning", message: "Warning" },
  toastWarningDescription: {
    id: "settings.general.toast.warning.description",
    message: "Attention needed, without blocking work",
  },
  toastError: { id: "settings.general.toast.error", message: "Error" },
  toastErrorDescription: {
    id: "settings.general.toast.error.description",
    message: "Failures and blocked actions",
  },
  mute: { id: "settings.general.toast.mute", message: "Mute" },
} as const

function muteToastLabel(label: string) {
  return { id: "settings.general.toast.mute.label", message: "Mute {label}", values: { label } }
}

function defaultDurationLabel(duration: string) {
  return { id: "settings.general.toast.duration.default", message: "Default {duration}", values: { duration } }
}

function toastDurationLabel(label: string) {
  return { id: "settings.general.toast.duration.label", message: "{label} toast duration", values: { label } }
}

function secondsLabel(value: number) {
  return { id: "settings.general.toast.duration.seconds", message: "{value}s", values: { value } }
}

export function GeneralPanel(props: {
  general: GeneralStore
  onGeneralChange: <K extends keyof GeneralStore>(key: K, value: GeneralStore[K]) => void
}) {
  const theme = useTheme()
  const selectedThemeId = () => props.general.theme || "synergy"
  const { _ } = useLingui()
  const locale = useLocale()
  const colorSchemeOptions = () => [
    {
      value: "light" as const,
      label: _(copy.colorLight),
      description: _(copy.colorLightDescription),
      iconToken: "settings.colorLight" as const,
    },
    {
      value: "dark" as const,
      label: _(copy.colorDark),
      description: _(copy.colorDarkDescription),
      iconToken: "settings.colorDark" as const,
    },
    {
      value: "system" as const,
      label: _(copy.colorSystem),
      description: _(copy.colorSystemDescription),
      iconToken: "settings.colorSystem" as const,
    },
  ]

  function setThemeId(themeId: string) {
    const next = themeId === "synergy" ? "" : themeId
    props.onGeneralChange("theme", next)
    theme.setThemeId(themeId)
  }

  async function setLocalePreference(preference: LocalePreference) {
    const changed = await applyLocalePreference({
      preference,
      controller: locale.controller,
      onChange: (next) => props.onGeneralChange("locale", next),
    })
    if (changed) return
    showToast({
      type: "error",
      title: _(copy.languageFailedTitle),
      description: _(copy.languageFailedDescription),
    })
  }

  function toggleMutedToast(type: ToastType, mutedEnabled: boolean) {
    const next = nextMutedToasts(props.general.mutedToasts, type, mutedEnabled)
    props.onGeneralChange("mutedToasts", next)
    setToastConfig(toastConfigFromPreferences(next, props.general.toastDurations))
  }

  function setToastDuration(type: ToastType, value: string) {
    const next = {
      ...props.general.toastDurations,
      [type]: value,
    }
    props.onGeneralChange("toastDurations", next)
    setToastConfig(toastConfigFromPreferences(props.general.mutedToasts, next))
  }

  return (
    <SettingsPage title={_(copy.pageTitle)} description={_(copy.pageDescription)}>
      <SettingsSection title={_(copy.appearanceTitle)}>
        <SettingRow
          title={_(copy.themeTitle)}
          description={_(copy.themeDescription)}
          trailing={
            <select
              class="settings-select"
              value={selectedThemeId()}
              onChange={(event) => setThemeId(event.currentTarget.value)}
            >
              <For each={theme.themes()}>{(option) => <option value={option.id}>{option.label}</option>}</For>
            </select>
          }
        />
        <div class="settings-color-grid" role="radiogroup" aria-label={_(copy.colorSchemeLabel)}>
          <For each={colorSchemeOptions()}>
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
        <SettingRow
          title={_(copy.languageTitle)}
          description={_(copy.languageDescription)}
          trailing={
            <select
              class="settings-select"
              value={props.general.locale}
              aria-label={_(copy.languageTitle)}
              onChange={(event) => void setLocalePreference(event.currentTarget.value as LocalePreference)}
            >
              <option value="system">{_(copy.languageSystem)}</option>
              <option value="en">{LANGUAGE_SELF_NAMES.en}</option>
              <option value="zh-CN">{LANGUAGE_SELF_NAMES["zh-CN"]}</option>
            </select>
          }
        />
      </SettingsSection>

      <SettingsSection title={_(copy.behaviorTitle)}>
        <SettingRow
          title={_(copy.snapshotsTitle)}
          description={_(copy.snapshotsDescription)}
          trailing={
            <Switch checked={props.general.snapshot} onChange={(value) => props.onGeneralChange("snapshot", value)} />
          }
        />
        <ProductUpdates />
      </SettingsSection>

      <SettingsSection title={_(copy.notificationsTitle)} description={_(copy.notificationsDescription)}>
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

function ProductUpdates() {
  const update = useProductUpdate()
  const { _, i18n } = useLingui()
  const status = update.desktopStatus
  const serverStatus = update.serverStatus
  const isDesktop = () => update.surface === "desktop"
  const mode = () => status()?.mode ?? "auto"
  const phase = () => status()?.phase ?? "idle"
  const serverActionState = () => serverUpdateActionState(serverStatus())
  const busy = () => Boolean(update.busy())

  return (
    <div class="settings-update-block">
      <div class="settings-update-header">
        <div class="settings-update-copy">
          <span class="settings-update-title">{_(copy.productUpdatesTitle)}</span>
          <span class="settings-update-description">
            <Show
              when={isDesktop()}
              fallback={
                <Show when={update.webRefreshEnabled} fallback={_(copy.productUpdatesDevelopment)}>
                  {_(copy.productUpdatesWeb)}
                </Show>
              }
            >
              {_(copy.productUpdatesDesktop)}
            </Show>
          </span>
        </div>
        <Show
          when={isDesktop()}
          fallback={
            <Button
              type="button"
              variant={update.webNeedsRefresh() ? "primary" : "secondary"}
              size="small"
              disabled={busy()}
              onClick={() => (update.webNeedsRefresh() ? void update.refreshWebClient() : void update.checkNow())}
            >
              {update.webNeedsRefresh() ? _(copy.refreshToUpdate) : busy() ? _(copy.checking) : _(copy.checkVersion)}
            </Button>
          }
        >
          <SegmentPill
            value={mode()}
            options={[
              { value: "auto", label: _(copy.modeAuto) },
              { value: "notify", label: _(copy.modeNotify) },
              { value: "manual", label: _(copy.modeManual) },
              { value: "none", label: _(copy.modeOff) },
            ]}
            onChange={(value) => void update.setDesktopMode(value as DesktopUpdateMode)}
          />
        </Show>
      </div>

      <Show
        when={isDesktop()}
        fallback={
          <div class="settings-update-status">
            <div class="settings-update-lines">
              <span>{translateDescriptor(webVersionStatus(update.appVersion, update.serverVersion()), i18n())}</span>
              <span>{translateDescriptor(serverUpdateStatusCopy(serverStatus()), i18n())}</span>
            </div>
            <Show when={serverStatus()?.capability === "managed"}>
              <div class="settings-update-actions">
                <Button
                  type="button"
                  variant="secondary"
                  size="small"
                  disabled={busy() || serverActionState() === "reconnecting"}
                  onClick={() => void update.checkNow()}
                >
                  {update.busy() === "check" ? _(copy.checking) : _(copy.checkServer)}
                </Button>
                <Show when={serverActionState() !== "hidden"}>
                  <Button
                    type="button"
                    variant="primary"
                    size="small"
                    disabled={busy() || serverActionState() === "reconnecting"}
                    onClick={() => void update.startServerUpdate()}
                  >
                    {serverActionState() === "reconnecting" ? _(copy.reconnecting) : _(copy.updateService)}
                  </Button>
                </Show>
              </div>
            </Show>
          </div>
        }
      >
        <div class="settings-update-status">
          <span>{translateDescriptor(desktopUpdateStatusCopy(status()), i18n())}</span>
          <div class="settings-update-actions">
            <Button
              type="button"
              variant="secondary"
              size="small"
              disabled={busy() || phase() === "disabled" || phase() === "checking" || phase() === "installing"}
              onClick={() => void update.checkNow()}
            >
              {phase() === "checking" ? _(copy.checking) : _(copy.checkNow)}
            </Button>
            <Show when={phase() === "available"}>
              <Button
                type="button"
                variant="secondary"
                size="small"
                disabled={busy()}
                onClick={() => void update.downloadDesktopUpdate()}
              >
                {_(copy.download)}
              </Button>
            </Show>
            <Show when={phase() === "ready" || phase() === "downloading"}>
              <Button
                type="button"
                variant="primary"
                size="small"
                disabled={busy() || phase() === "downloading"}
                onClick={() => void update.installDesktopUpdate()}
              >
                {phase() === "downloading"
                  ? translateDescriptor(downloadLabel(status()), i18n())
                  : _(copy.restartToUpdate)}
              </Button>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  )
}

function ToastPreferenceRow(props: {
  type: ToastType
  muted: boolean
  duration: string
  onMutedChange: (value: boolean) => void
  onDurationChange: (value: string) => void
}) {
  const { _ } = useLingui()
  const copyForType = () => {
    if (props.type === "info") return { label: _(copy.toastInfo), description: _(copy.toastInfoDescription) }
    if (props.type === "success") return { label: _(copy.toastSuccess), description: _(copy.toastSuccessDescription) }
    if (props.type === "warning") return { label: _(copy.toastWarning), description: _(copy.toastWarningDescription) }
    return { label: _(copy.toastError), description: _(copy.toastErrorDescription) }
  }
  const duration = () => {
    const parsed = Number(props.duration)
    return Number.isFinite(parsed) && parsed > 0 ? snapToastDuration(parsed) : DEFAULT_TOAST_DURATION_MS
  }
  const hasOverride = () => props.duration.trim().length > 0
  const durationIndex = () => nearestDurationIndex(duration())

  return (
    <div class="settings-toast-row">
      <div class="settings-toast-copy">
        <span class="settings-toast-title">{copyForType().label}</span>
        <span class="settings-toast-description">{copyForType().description}</span>
      </div>

      <div class="settings-toast-controls">
        <div class="settings-muted-toggle">
          <span aria-hidden="true">{_(copy.mute)}</span>
          <Switch checked={props.muted} hideLabel onChange={props.onMutedChange}>
            {_(muteToastLabel(copyForType().label))}
          </Switch>
        </div>

        <div class="settings-duration-control">
          <div class="settings-duration-header">
            <span>
              {hasOverride()
                ? _(secondsLabel(duration() / 1000))
                : _(defaultDurationLabel(_(secondsLabel(DEFAULT_TOAST_DURATION_MS / 1000))))}
            </span>
          </div>
          <input
            class="settings-duration-slider"
            type="range"
            min="0"
            max={String(TOAST_DURATION_STOPS.length - 1)}
            step="1"
            value={durationIndex()}
            aria-label={_(toastDurationLabel(copyForType().label))}
            onInput={(event) => {
              const index = Number(event.currentTarget.value)
              const next = TOAST_DURATION_STOPS[index] ?? TOAST_DURATION_STOPS[0]
              props.onDurationChange(next === DEFAULT_TOAST_DURATION_MS ? "" : String(next))
            }}
          />
          <div class="settings-duration-ticks" aria-hidden="true">
            <For each={TOAST_DURATION_STOPS}>{(stop) => <span>{_(secondsLabel(stop / 1000))}</span>}</For>
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
