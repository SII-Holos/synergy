import { For, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { useTheme } from "@ericsanchezok/synergy-ui/theme"
import { useProductUpdate } from "@/context/product-update"
import type { LocalePreference } from "@/context/locale"
import { translateDescriptor } from "@/locales/translate"
import { usePlatform, type DesktopUpdateMode } from "@/context/platform"
import { DevicePushBlock } from "./DevicePushBlock"
import { SettingRow } from "../components/SettingRow"
import { SegmentPill } from "../components/SegmentPill"
import { ThemePicker } from "../components/ThemePicker"
import { MenuField } from "../../menu-field/MenuField"
import { SettingsPage, SettingsSection } from "../components/SettingsPrimitives"
import { InterfaceZoom } from "./interface-zoom"
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
  type ActivityDisplay,
  type GeneralStore,
  type ToastType,
} from "../types"
import type { NewSessionWorkspacePreference } from "@/components/session/worktree-session"
import { nextMutedToasts } from "../toast-preferences"
import { LANGUAGE_SELF_NAMES } from "./language-self-names"
import { useFontPreference, type FontKind } from "@/context/font-preference"

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
  fontTitle: { id: "settings.general.font.title", message: "Interface font" },
  fontDescription: {
    id: "settings.general.font.description",
    message: "Check loads the fonts installed on this device. Save Changes applies your selection.",
  },
  fontSelectPlaceholder: { id: "settings.general.font.select.placeholder", message: "Select a font" },
  fontCheck: { id: "settings.general.font.check", message: "Check" },
  fontChecking: { id: "settings.general.font.checking", message: "Loading..." },
  fontReset: { id: "settings.general.font.reset", message: "Use default" },
  fontApplied: { id: "settings.general.font.applied", message: "Applied" },
  fontReady: { id: "settings.general.font.ready", message: "Unsaved selection" },
  fontUnsupported: {
    id: "settings.general.font.unsupported",
    message: "This browser cannot scan local fonts; using default",
  },
  fontDenied: {
    id: "settings.general.font.denied",
    message: "Font access was denied; using default",
  },
  fontDefault: { id: "settings.general.font.default", message: "Using default" },
  monoFontTitle: { id: "settings.general.monoFont.title", message: "Monospace font" },
  monoFontDescription: {
    id: "settings.general.monoFont.description",
    message: "Used for code, terminals, diffs, and other monospaced content.",
  },
  behaviorTitle: { id: "settings.general.behavior.title", message: "Behavior" },
  snapshotsTitle: { id: "settings.general.snapshots.title", message: "File snapshots" },
  activityDisplayTitle: { id: "settings.general.activityDisplay.title", message: "Activity display" },
  activityDisplayDescription: {
    id: "settings.general.activityDisplay.description",
    message: "Choose how much activity detail Synergy shows in the interface",
  },
  activityFull: { id: "settings.general.activityDisplay.full", message: "Full" },
  activityBalanced: { id: "settings.general.activityDisplay.balanced", message: "Balanced" },
  activityMinimal: { id: "settings.general.activityDisplay.minimal", message: "Minimal" },
  workspaceTitle: { id: "settings.general.workspace.title", message: "New session workspace" },
  workspaceDescription: {
    id: "settings.general.workspace.description",
    message: "Start new sessions in the main checkout or an isolated git worktree",
  },
  workspaceMain: { id: "settings.general.workspace.main", message: "Main checkout" },
  workspaceWorktree: { id: "settings.general.workspace.worktree", message: "Worktree" },
  snapshotsDescription: {
    id: "settings.general.snapshots.description",
    message: "Keep restore points when Synergy edits files",
  },
  compactReasoningTitle: { id: "settings.general.compactReasoning.title", message: "Compact reasoning" },
  compactReasoningDescription: {
    id: "settings.general.compactReasoning.description",
    message: "Show live reasoning in a single line; completed turns keep an expandable reasoning row",
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
  desktopUpdateMode?: DesktopUpdateMode
  onGeneralChange: <K extends keyof GeneralStore>(key: K, value: GeneralStore[K]) => void
  onDesktopUpdateModeChange: (mode: DesktopUpdateMode) => void
  desktopZoom?: number
  onDesktopZoomChange?: (factor: number) => void
  popoverLayer?: HTMLElement
}) {
  const theme = useTheme()
  const selectedThemeId = () => props.general.theme || "synergy"
  const { _ } = useLingui()
  const platform = usePlatform()
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
    props.onGeneralChange("theme", themeId === "synergy" ? "" : themeId)
  }

  function toggleMutedToast(type: ToastType, mutedEnabled: boolean) {
    props.onGeneralChange("mutedToasts", nextMutedToasts(props.general.mutedToasts, type, mutedEnabled))
  }

  function setToastDuration(type: ToastType, value: string) {
    props.onGeneralChange("toastDurations", {
      ...props.general.toastDurations,
      [type]: value,
    })
  }

  return (
    <SettingsPage title={_(copy.pageTitle)} description={_(copy.pageDescription)}>
      <SettingsSection title={_(copy.appearanceTitle)}>
        <div class="settings-theme-picker-section">
          <div class="settings-theme-picker-copy">
            <span class="settings-row-title">{_(copy.themeTitle)}</span>
            <span class="settings-row-description">{_(copy.themeDescription)}</span>
          </div>
          <ThemePicker
            ariaLabel={_(copy.themeTitle)}
            mode={theme.mode()}
            themes={theme.themes()}
            value={selectedThemeId()}
            onChange={setThemeId}
          />
        </div>
        <div class="settings-color-grid" role="radiogroup" aria-label={_(copy.colorSchemeLabel)}>
          <For each={colorSchemeOptions()}>
            {(option) => (
              <button
                type="button"
                role="radio"
                aria-checked={props.general.colorScheme === option.value}
                class="settings-color-card"
                classList={{ "settings-color-card-active": props.general.colorScheme === option.value }}
                onClick={() => props.onGeneralChange("colorScheme", option.value)}
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
            <MenuField
              value={props.general.locale}
              ariaLabel={_(copy.languageTitle)}
              popoverLayer={props.popoverLayer}
              options={[
                { value: "system", label: _(copy.languageSystem) },
                { value: "en", label: LANGUAGE_SELF_NAMES.en },
                { value: "zh-CN", label: LANGUAGE_SELF_NAMES["zh-CN"] },
              ]}
              onChange={(value) => props.onGeneralChange("locale", value as LocalePreference)}
            />
          }
        />
        <SettingRow
          title={_(copy.activityDisplayTitle)}
          description={_(copy.activityDisplayDescription)}
          trailing={
            <SegmentPill
              value={props.general.activityDisplay}
              options={[
                { value: "full", label: _(copy.activityFull) },
                { value: "balanced", label: _(copy.activityBalanced) },
                { value: "minimal", label: _(copy.activityMinimal) },
              ]}
              onChange={(value) => props.onGeneralChange("activityDisplay", value as ActivityDisplay)}
            />
          }
        />
        <FontPreferenceRow
          kind="sans"
          title={_(copy.fontTitle)}
          description={_(copy.fontDescription)}
          popoverLayer={props.popoverLayer}
        />
        <FontPreferenceRow
          kind="mono"
          title={_(copy.monoFontTitle)}
          description={_(copy.monoFontDescription)}
          popoverLayer={props.popoverLayer}
        />
        <Show when={platform.desktopZoom}>
          <InterfaceZoom zoom={props.desktopZoom ?? 1} onZoomChange={(factor) => props.onDesktopZoomChange?.(factor)} />
        </Show>
      </SettingsSection>

      <SettingsSection title={_(copy.behaviorTitle)}>
        <SettingRow
          title={_(copy.snapshotsTitle)}
          description={_(copy.snapshotsDescription)}
          trailing={
            <Switch checked={props.general.snapshot} onChange={(value) => props.onGeneralChange("snapshot", value)} />
          }
        />
        <SettingRow
          title={_(copy.compactReasoningTitle)}
          description={_(copy.compactReasoningDescription)}
          trailing={
            <Switch
              checked={props.general.compactReasoning}
              onChange={(value) => props.onGeneralChange("compactReasoning", value)}
            />
          }
        />
        <SettingRow
          title={_(copy.workspaceTitle)}
          description={_(copy.workspaceDescription)}
          trailing={
            <SegmentPill
              value={props.general.defaultSessionWorkspace}
              ariaLabel={_(copy.workspaceTitle)}
              options={[
                { value: "main", label: _(copy.workspaceMain) },
                { value: "worktree", label: _(copy.workspaceWorktree) },
              ]}
              onChange={(value) =>
                props.onGeneralChange("defaultSessionWorkspace", value as NewSessionWorkspacePreference)
              }
            />
          }
        />
        <ProductUpdates mode={props.desktopUpdateMode} onModeChange={props.onDesktopUpdateModeChange} />
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
        <DevicePushBlock />
      </SettingsSection>
    </SettingsPage>
  )
}

function FontPreferenceRow(props: { kind: FontKind; title: string; description: string; popoverLayer?: HTMLElement }) {
  const { _ } = useLingui()
  const font = useFontPreference()

  const phase = () => font.phase(props.kind)
  const loading = () => phase() === "loading"
  const ready = () => phase() === "ready"
  const selectedFamily = () => font.selected(props.kind)
  const appliedFamily = () => font.appliedFamily(props.kind)
  const hasCustomFont = () => Boolean(appliedFamily())
  const hasFontChoice = () => Boolean(selectedFamily() || appliedFamily())
  const options = () => font.fontList(props.kind).map((family) => ({ value: family, label: family }))
  const actionDisabled = () => loading()
  const actionLabel = () => (loading() ? _(copy.fontChecking) : _(copy.fontCheck))

  function statusLabel() {
    const phaseValue = phase()
    if (phaseValue === "loading") return _(copy.fontChecking)
    if (phaseValue === "unsupported") return _(copy.fontUnsupported)
    if (phaseValue === "denied") return _(copy.fontDenied)
    if (font.dirty(props.kind)) return _(copy.fontReady)
    if (hasCustomFont()) return _(copy.fontApplied)
    return _(copy.fontDefault)
  }

  return (
    <SettingRow
      title={props.title}
      description={props.description}
      stateLabel={statusLabel()}
      trailing={
        <div class="settings-font-controls">
          <Button
            type="button"
            variant="ghost"
            size="small"
            disabled={!hasFontChoice()}
            onClick={() => font.reset(props.kind)}
          >
            {_(copy.fontReset)}
          </Button>
          <MenuField
            value={selectedFamily()}
            ariaLabel={props.title}
            popoverLayer={props.popoverLayer}
            triggerLabel={selectedFamily() || _(copy.fontSelectPlaceholder)}
            options={options()}
            disabled={!ready()}
            onChange={(value) => font.select(props.kind, value)}
          />
          <Show when={!ready()}>
            <Button
              type="button"
              variant="secondary"
              size="small"
              disabled={actionDisabled()}
              onClick={() => void font.check(props.kind)}
            >
              {actionLabel()}
            </Button>
          </Show>
        </div>
      }
    />
  )
}

function ProductUpdates(props: { mode?: DesktopUpdateMode; onModeChange: (mode: DesktopUpdateMode) => void }) {
  const update = useProductUpdate()
  const { _, i18n } = useLingui()
  const status = update.desktopStatus
  const serverStatus = update.serverStatus
  const isDesktop = () => update.surface === "desktop"
  const mode = () => props.mode ?? status()?.mode ?? "auto"
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
            onChange={(value) => props.onModeChange(value as DesktopUpdateMode)}
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
