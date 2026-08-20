import {
  ErrorBoundary,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  Show,
  type Component,
  type JSX,
} from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { Dynamic } from "solid-js/web"
import { createMediaQuery } from "@solid-primitives/media"
import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon, type IconName } from "@ericsanchezok/synergy-ui/icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useTheme, type ColorScheme } from "@ericsanchezok/synergy-ui/theme"
import type {
  ChannelStatus,
  ConfigDomainSummary,
  ControlProfileSummary,
  CortexConcurrencyStatus,
  ModelRoleSummary,
  SandboxStatus,
  SkillList,
} from "@ericsanchezok/synergy-sdk/client"
import type { PluginSettingsComponentProps, PluginSettingsSurfaceContext } from "@ericsanchezok/synergy-plugin"
import { useGlobalSDK } from "@/context/global-sdk"
import { useInput } from "@/context/input"
import { useGlobalSync } from "@/context/global-sync"
import { useLocale } from "@/context/locale"
import { usePlatform, type DesktopUpdateMode } from "@/context/platform"
import { useProductUpdate } from "@/context/product-update"
import { useFontPreference } from "@/context/font-preference"
import { useHolos } from "@/context/holos"
import { useConfirm, type ConfirmOptions } from "@/components/dialog/confirm-dialog"
import {
  getSettingsSections,
  subscribeSettingsSections,
  type SettingsSection as RegisteredSettingsSection,
} from "@/plugin"
import { DeclarativeSettingsForm } from "@/plugin/components/declarative-settings-form"
import { AppPanel } from "@/components/app-panel"
import { translateDescriptor } from "@/locales/translate"
import { requestErrorMessage } from "@/utils/error"
import "./settings-panel.css"
import type { DialogSettingsProps, McpEntry, ModelsStore, ProviderGroup, ProviderModel, SettingsState } from "./types"
import { defaultSettingsState, emptyMcp, groupByProvider } from "./types"
import { isBuiltinSettingsId, settingsGroupOrder } from "./catalog"
import { ensureInit } from "./hooks/useSettingsForm"
import { buildPatch } from "./hooks/useConfigPatch"
import { useSettingsSave } from "./hooks/useSettingsSave"
import {
  hasExplicitSettingsChanges,
  rebaseDraftAfterSave,
  retainDraftAfterSave,
  saveExplicitSettingsChanges,
  snapshotSettingsDraft,
  themeIdToSettingsValue,
} from "./settings-explicit-save"
import { prepareLocaleSettingsSave, rejectLocaleSettingsSave } from "./settings-locale-save"
import { pluginSettingsResourceKey } from "./plugin-settings-resource"
import { createSettingsComponentLoader } from "./settings-component-loader"
import { createPluginSettingsDrafts } from "./plugin-settings-drafts"
import { SettingsDialogFrame } from "./settings-dialog-frame"
import { settingsSaveFooterStatus } from "./settings-save-status"
import {
  createSettingsMobileNavigationState,
  reduceSettingsMobileNavigation,
  restoreSettingsMobileListFocus,
} from "./settings-mobile-navigation"
import { GeneralPanel } from "./panels/GeneralPanel"
import { ModelsPanel } from "./panels/ModelsPanel"
import { ProvidersPanel } from "./panels/ProvidersPanel"
import { isSelectableModel } from "@/components/provider/model-catalog"
import { AccountPanel } from "./panels/AccountPanel"
import { PersonalizePanel } from "./panels/PersonalizePanel"
import { createPersonalizeController } from "./panels/personalize-controller"
import { UsagePanel } from "./panels/UsagePanel"
import { GitHubPanel } from "./panels/GitHubPanel"
import { SynergyLinkPanel } from "./panels/SynergyLinkPanel"
import { McpPanel } from "./panels/McpPanel"
import { LearningPanel, MemoryPanel, ExperiencePanel } from "./panels/LibraryPanels"
import { ChannelsPanel } from "./panels/ChannelsPanel"
import { EmailPanel } from "./panels/EmailPanel"
import { ImportPanel } from "./panels/ImportPanel"
import { ConfigFilesPanel, ConfigReferencePanel } from "./panels/ConfigFilesPanel"
import { ArchivedSessionsPanel } from "./panels/ArchivedSessionsPanel"
import { WorktreesPanel } from "./panels/WorktreesPanel"
import { ControlProfilePanel, PermissionsPanel, SandboxPanel } from "./panels/SafetyPanels"
import { CompactionPanel, QuestionsPanel, TimeoutsPanel, ObservabilityPanel } from "./panels/RuntimePanels"
import { BossModePanel } from "./panels/BossModePanel"
import { CodeChecksPanel } from "./panels/CodeChecksPanel"
import { SkillsPanel } from "./panels/SkillsPanel"
import { SettingsPage, SettingsSection } from "./components/SettingsPrimitives"
import { filterSettingsSections, SETTINGS_DEVELOPER_MODE_STORAGE_KEY } from "./settings-visibility"
import { SaveIndicator } from "./components/SaveIndicator"
import { canUseConfigFileOpen, configFileOpenFailure } from "./config-file-open-model"
import { localizeSettingsSection, settingsSectionGroupKey } from "./settings-section-copy"
import {
  canRefreshChannelAccount,
  channelRuntimeStatusLabel,
  clarusAccountDisplayName,
  clarusDiagnosticsFilename,
  shouldRefreshChannelStatuses,
} from "./channel-account-model"
import { SlotOutlet } from "@/plugin/slot-outlet"

function settingsValues(value: unknown, fallback: Record<string, unknown> = {}): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : fallback
}

const legacyInitialTabs: Record<string, string> = {
  advanced: "control-profile",
  appearance: "general",
  holos: "account",
  library: "learning",
  profile: "account",
}

const copy = {
  dialogLabel: { id: "settings.panel.dialog.label", message: "Settings" },
  closeLabel: { id: "settings.panel.close.label", message: "Close settings" },
  backLabel: { id: "settings.panel.back.label", message: "Back" },
  globalConfig: { id: "settings.panel.globalConfig.label", message: "Global Config" },
  customInstructionsNotSaved: {
    id: "settings.panel.customInstructions.notSaved",
    message: "Custom instructions not saved",
  },
  customInstructionsReview: {
    id: "settings.panel.customInstructions.review",
    message: "Review the Custom Instructions content and try again.",
  },
  customInstructionsSaved: {
    id: "settings.panel.customInstructions.saved",
    message: "Custom instructions saved",
  },
  customInstructionsReset: {
    id: "settings.panel.customInstructions.reset",
    message: "Custom instructions reset",
  },
  customInstructionsOverride: {
    id: "settings.panel.customInstructions.override",
    message: "Synergy will use AGENTS.override.md for subsequent prompt assembly.",
  },
  customInstructionsGlobal: {
    id: "settings.panel.customInstructions.global",
    message: "Synergy will fall back to the global AGENTS.md file.",
  },
  configFileOpened: { id: "settings.panel.configFile.opened", message: "Config file opened" },
  formatterTitle: { id: "settings.panel.reference.formatterTitle", message: "Formatter" },
  formatterDescription: {
    id: "settings.panel.reference.formatterDescription",
    message: "Formatter configuration file access.",
  },
  lspTitle: { id: "settings.panel.reference.lspTitle", message: "LSP" },
  lspDescription: {
    id: "settings.panel.reference.lspDescription",
    message: "Language server configuration file access.",
  },
  pluginsGroup: { id: "settings.panel.group.plugins", message: "Plugins" },
  errorBadge: { id: "settings.panel.badge.error", message: "Error" },
  unsavedBadge: { id: "settings.panel.badge.unsaved", message: "Unsaved" },
  savingBadge: { id: "settings.panel.badge.saving", message: "Saving" },
  savedBadge: { id: "settings.panel.badge.saved", message: "Saved" },
  developerBadge: { id: "settings.panel.badge.developer", message: "Dev" },
  searchPlaceholder: { id: "settings.panel.search.placeholder", message: "Search settings..." },
  noSettings: { id: "settings.panel.search.empty", message: "No settings found" },
  developerMode: { id: "settings.panel.developerMode.label", message: "Developer mode" },
  cancel: { id: "settings.panel.action.cancel", message: "Cancel" },
  saving: { id: "settings.panel.action.saving", message: "Saving..." },
  saveChanges: { id: "settings.panel.action.saveChanges", message: "Save Changes" },
  loading: { id: "settings.panel.loading.label", message: "Loading..." },
  emptyTitle: { id: "settings.panel.empty.title", message: "Settings" },
  emptyDescription: { id: "settings.panel.empty.description", message: "Select a settings section." },
  noSection: { id: "settings.panel.empty.noSection", message: "No section selected" },
  sectionUnavailable: {
    id: "settings.panel.section.unavailable",
    message: "{label} is not available",
  },
  partialSaveFailed: { id: "settings.panel.save.partialFailure", message: "Some settings were not saved" },
  partialSaveReview: {
    id: "settings.panel.save.partialFailure.description",
    message: "Review the failed settings and try again.",
  },
  clarusRefreshFailed: { id: "settings.channels.clarus.refreshFailed", message: "Failed to refresh Clarus projects" },
  clarusDiagnosticsFailed: {
    id: "settings.channels.clarus.diagnosticsFailed",
    message: "Failed to download Clarus diagnostics",
  },
  configDiagnosticsTitle: {
    id: "settings.panel.configDiagnostics.title",
    message: "Configuration issues found",
  },
  configDiagnosticsDescription: {
    id: "settings.panel.configDiagnostics.description",
    message:
      "One or more config files could not be loaded and were set aside. Fix the file and rename it back to continue using those settings.",
  },
  configDiagnosticsDetail: {
    id: "settings.panel.configDiagnostics.detail",
    message: "{path}: {error}",
  },
  configDiagnosticsQuarantined: {
    id: "settings.panel.configDiagnostics.quarantined",
    message: "Moved to {path}",
  },
  interfaceZoomRow: { id: "settings.catalog.general.row.zoom", message: "Interface Zoom" },
  themeSaveFailed: { id: "settings.panel.theme.saveFailed", message: "Theme change could not be saved" },
}

export type SettingsPanelProps = DialogSettingsProps & {
  onClose?: () => void
}

export function SettingsDialog(props: DialogSettingsProps) {
  const dialog = useDialog()
  const { _ } = useLingui()
  return (
    <SettingsDialogFrame ariaLabel={_(copy.dialogLabel)}>
      <SettingsPanel {...props} onClose={() => dialog.close()} />
    </SettingsDialogFrame>
  )
}

export function SettingsPanel(props: SettingsPanelProps) {
  const { _, i18n } = useLingui()
  const dialog = useDialog()
  const confirm = useConfirm()
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const locale = useLocale()
  const input = useInput()
  const platform = usePlatform()
  const productUpdate = useProductUpdate()
  const theme = useTheme()
  const font = useFontPreference()
  const holos = useHolos()
  const personalizeController = createPersonalizeController({
    get: async () => (await globalSDK.client.config.instructions.get()).data!,
    update: async (content) =>
      (
        await globalSDK.client.config.instructions.update({
          configInstructionsUpdateInput: { content },
        })
      ).data!,
    reset: async () => (await globalSDK.client.config.instructions.reset()).data!,
  })

  const isDesktop = createMediaQuery("(min-width: 768px)")
  const initialTab = normalizeInitialTab(props.initialTab)
  const initialDeveloperMode = readDeveloperMode()
  const initialNavigation = createSettingsMobileNavigationState(
    initialTab,
    filterSettingsSections(getSettingsSections(), initialDeveloperMode).map((section) => section.id),
    isDesktop(),
  )
  let settingsNavigation: HTMLDivElement | undefined
  const [navigation, setNavigation] = createSignal(initialNavigation)
  const activeTab = () => navigation().activeTab
  const mobileDetailOpen = () => navigation().detailOpen
  const setActiveTab = (id: string) =>
    setNavigation((state) => reduceSettingsMobileNavigation(state, { type: "select", id }))
  const showMobileSectionList = () => {
    setNavigation((state) => reduceSettingsMobileNavigation(state, { type: "back" }))
    restoreSettingsMobileListFocus(settingsNavigation)
  }
  const [providerFocusID, setProviderFocusID] = createSignal(props.providerFocusID)
  const [search, setSearch] = createSignal("")
  const [initialized, setInitialized] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const [aggregateSaveStatus, setAggregateSaveStatus] = createSignal<"idle" | "saving" | "saved" | "error">("idle")
  const [saveResultFingerprint, setSaveResultFingerprint] = createSignal<string>()
  const [desktopUpdateDraft, setDesktopUpdateDraft] = createSignal<DesktopUpdateMode>()
  const [desktopZoomDraft, setDesktopZoomDraft] = createSignal<number>()
  const [pluginDraftVersion, setPluginDraftVersion] = createSignal(0)
  const pluginDrafts = createPluginSettingsDrafts(() => setPluginDraftVersion((version) => version + 1))
  const [refreshing, setRefreshing] = createSignal(false)
  const [openingDomain, setOpeningDomain] = createSignal<string | undefined>()
  const [settingsPopoverLayer, setSettingsPopoverLayer] = createSignal<HTMLElement>()
  const [developerMode, setDeveloperMode] = createSignal(initialDeveloperMode)
  const [settingsRegistryVersion, setSettingsRegistryVersion] = createSignal(0)
  let settingsRegistryRefreshScheduled = false
  let mobileBackButton: HTMLButtonElement | undefined
  let settingsRegistryDisposed = false
  const unsubscribeSettingsSections = subscribeSettingsSections(() => {
    if (settingsRegistryRefreshScheduled) return
    settingsRegistryRefreshScheduled = true
    queueMicrotask(() => {
      settingsRegistryRefreshScheduled = false
      if (!settingsRegistryDisposed) setSettingsRegistryVersion((version) => version + 1)
    })
  })
  onCleanup(() => {
    settingsRegistryDisposed = true
    unsubscribeSettingsSections()
  })

  const [settings, setSettings] = createStore<SettingsState>(
    defaultSettingsState(input.sendShortcut(), theme.colorScheme()),
  )

  const [config, { refetch: refetchConfig }] = createResource(async () => {
    const res = await globalSDK.client.config.global()
    return res.data!
  })

  const [channelStatuses, { refetch: refetchChannelStatuses }] = createResource(async () => {
    const res = await globalSDK.client.channel.status()
    return (res.data ?? {}) as Record<string, ChannelStatus>
  })

  const unsubscribeChannelStatuses = globalSDK.event.listen((event) => {
    if (shouldRefreshChannelStatuses(event.details?.type)) void refetchChannelStatuses()
  })
  onCleanup(unsubscribeChannelStatuses)

  const [cortexConcurrencyStatus, { refetch: refetchCortexConcurrencyStatus }] = createResource(async () => {
    const res = await globalSDK.client.cortex.concurrency()
    return res.data as CortexConcurrencyStatus | undefined
  })

  const [domainSummaries, { refetch: refetchDomains }] = createResource(async () => {
    const res = await globalSDK.client.config.domain.list()
    return res.data ?? []
  })

  const [configDiagnostics] = createResource(async () => {
    const res = await globalSDK.client.config.diagnostics()
    return res.data?.issues ?? []
  })

  const [desktopServerStatus] = createResource(async () => {
    if (platform.platform !== "desktop" || !platform.desktopServer) return null
    return platform.desktopServer.status().catch(() => null)
  })
  const [desktopZoomSaved, { mutate: setDesktopZoomSaved }] = createResource(async () => {
    if (!platform.desktopZoom) return undefined
    return platform.desktopZoom.get().catch(() => undefined)
  })

  const canOpenConfigFiles = createMemo(() => canUseConfigFileOpen(platform, desktopServerStatus()))

  const [modelRoleSummaries, { refetch: refetchModelRoleSummaries }] = createResource(async () => {
    const res = await globalSDK.client.app.agentModelRoles()
    return (res.data ?? []) as ModelRoleSummary[]
  })

  const [agents, { refetch: refetchAgents }] = createResource(async () => {
    const res = await globalSDK.client.app.agents()
    return res.data ?? []
  })
  const [skillSources, { refetch: refetchSkillSources }] = createResource(async () => {
    try {
      const res = await globalSDK.client.skill.list()
      return (res.data?.sources ?? []) as SkillList["sources"]
    } catch {
      return [] as SkillList["sources"]
    }
  })

  const providerModels = createMemo(() => {
    const data = globalSync.data.provider
    const list: ProviderModel[] = []
    for (const provider of data.all) {
      if (!data.connected.includes(provider.id)) continue
      if (data.runtimeAvailability?.[provider.id]?.available === false) continue
      for (const [modelId, model] of Object.entries(provider.models)) {
        if (!isSelectableModel(model)) continue
        list.push({
          providerId: provider.id,
          providerName: provider.name,
          modelId,
          modelName: model.name,
          variantKeys: model.variants ? Object.keys(model.variants) : [],
        })
      }
    }
    return list
  })

  const providerGroups = createMemo<ProviderGroup[]>(() => groupByProvider(providerModels()))

  const savedModels = createMemo<ModelsStore>(() => {
    const cfg = config()
    return {
      model: cfg?.model ?? "",
      nano_model: cfg?.nano_model ?? "",
      mini_model: cfg?.mini_model ?? "",
      mid_model: cfg?.mid_model ?? "",
      vision_model: cfg?.vision_model ?? "",
      thinking_model: cfg?.thinking_model ?? "",
      long_context_model: cfg?.long_context_model ?? "",
      creative_model: cfg?.creative_model ?? "",
      quick_switcher: cfg?.quick_switcher?.models ?? [],
    }
  })

  const providerSummaries = createMemo(() => {
    const data = globalSync.data.provider
    const providers = new Map(data.all.map((provider) => [provider.id, provider]))
    return Object.values(data.connections).map((connection) => {
      const provider = providers.get(connection.id)
      const health = data.authHealth?.[connection.id]
      const availability = data.runtimeAvailability?.[connection.id]
      return {
        ...connection,
        connected: data.connected.includes(connection.id),
        modelCount: availability?.modelCount ?? Object.keys(provider?.models ?? {}).length,
        health,
        availability,
        catalog: data.modelCatalog?.[connection.id],
        profile: data.profiles?.[connection.id],
      }
    })
  })

  const [controlProfiles] = createResource(async () => {
    const res = await globalSDK.client.controlProfile.list()
    return (res.data ?? []) as ControlProfileSummary[]
  })

  const [sandboxStatus] = createResource(async () => {
    const res = await globalSDK.client.sandbox.status()
    return res.data as SandboxStatus | undefined
  })

  const originalMcpsRef = { current: {} as Record<string, Record<string, unknown>> }
  let initializedForSet: string | undefined

  const doEnsureInit = () => {
    const result = ensureInit({
      cfg: config(),
      setName: "global",
      refreshing,
      initialized,
      initializedForSet,
      sendShortcut: () => input.sendShortcut(),
      colorScheme: theme.colorScheme,
      setSettings,
      setInitialized,
      originalMcpsRef,
    })
    if (result !== undefined) initializedForSet = result
  }

  createEffect(() => {
    config()
    doEnsureInit()
  })

  // Include agents() — the Agents page requires the agent list for the Default Agent dropdown.
  const ready = () => initialized() && !!domainSummaries() && !!modelRoleSummaries() && !!agents()

  function resetEditor() {
    setInitialized(false)
    initializedForSet = undefined
  }

  async function refreshAfterConfigChange(changedFields: string[], submittedDraft?: SettingsState) {
    setRefreshing(true)
    resetEditor()
    const changed = new Set(changedFields)
    // Refresh only the panel resources affected by the fields that actually
    // changed. The global sync store (provider/agent/command across scopes)
    // is refreshed by the runtime.reloaded event via refreshTargeted, so we
    // no longer trigger a full refreshAllConfigs() on every save.
    const modelFields = [
      "model",
      "nano_model",
      "mini_model",
      "mid_model",
      "thinking_model",
      "long_context_model",
      "creative_model",
      "vision_model",
      "role_variant",
    ]
    const agentFields = ["agent", "default_agent", "external_agent", "category", "permission", "library"]
    await Promise.all([
      refetchConfig(),
      refetchDomains(),
      ...(modelFields.some((field) => changed.has(field)) ? [refetchModelRoleSummaries()] : []),
      ...(agentFields.some((field) => changed.has(field)) ? [refetchAgents()] : []),
      ...(changed.has("cortex") ? [refetchCortexConcurrencyStatus()] : []),
      ...(changed.has("channel") ? [refetchChannelStatuses()] : []),
      ...(changed.has("skills") ? [refetchSkillSources()] : []),
    ])
    const currentDraft = submittedDraft ? snapshotSettingsDraft(settings) : undefined
    setRefreshing(false)
    doEnsureInit()
    if (submittedDraft && currentDraft) {
      setSettings(reconcile(rebaseDraftAfterSave(snapshotSettingsDraft(settings), submittedDraft, currentDraft)))
    }
    if (submittedDraft) restoreInstantTheme()
  }

  // Theme is applied instantly and persisted by a background update, so the
  // server config resource may still hold the previous value when the panel
  // re-initializes. Restore the live provider value on discard and after an
  // explicit save so the picker stays in sync with the applied appearance.
  // Config imports skip this: there the server value is the intended one.
  function restoreInstantTheme() {
    setSettings("general", "theme", themeIdToSettingsValue(theme.themeId()))
  }

  const serverPatch = createMemo<Record<string, unknown>>(() => {
    if (!initialized() || !config()) return {}
    return buildPatch({
      cfg: config()!,
      state: settings,
      originalMcps: originalMcpsRef.current,
    })
  })

  const hasServerChanges = createMemo(() => Object.keys(serverPatch()).length > 0)
  const hasPluginChanges = () => {
    pluginDraftVersion()
    return pluginDrafts.dirty()
  }
  const desktopUpdateDirty = () => {
    const draft = desktopUpdateDraft()
    return draft !== undefined && draft !== (productUpdate.desktopStatus()?.mode ?? "auto")
  }
  const desktopZoomDirty = () => {
    const draft = desktopZoomDraft()
    if (draft === undefined) return false
    // The slider steps in whole percent points; treat values within half a
    // step of the saved factor as unchanged to avoid rounding-induced dirt.
    return Math.abs(draft - (desktopZoomSaved() ?? 1)) > 0.005
  }
  const editingLabel = createMemo(() => _(copy.globalConfig))
  const hasAnyChanges = createMemo(
    () =>
      hasServerChanges() ||
      hasPluginChanges() ||
      personalizeController.dirty() ||
      font.dirty() ||
      desktopUpdateDirty() ||
      desktopZoomDirty(),
  )
  const draftFingerprint = createMemo(() =>
    JSON.stringify({
      server: serverPatch(),
      plugin: pluginDraftVersion(),
      personalize: [personalizeController.content(), personalizeController.resetPending()],
      font: [font.selected("sans"), font.selected("mono")],
      desktopUpdate: desktopUpdateDraft(),
      desktopZoom: desktopZoomDraft(),
    }),
  )

  function showConfirm(params: ConfirmOptions) {
    confirm.show(params)
  }

  function discardChanges() {
    pluginDrafts.discard()
    personalizeController.discard()
    font.discard()
    setDesktopUpdateDraft(undefined)
    setDesktopZoomDraft(undefined)
    resetEditor()
    doEnsureInit()
    restoreInstantTheme()
  }

  const save = useSettingsSave({
    serverPatch,
    serverDraft: () => snapshotSettingsDraft(settings),
    domainSummaries: () => domainSummaries() ?? [],
    hasAnyChanges,
    editingLabel,
    refreshAfterConfigChange,
    preparePatchSave: (patch) => prepareLocaleSettingsSave(patch, locale.controller),
    rejectPatchSave: async (patch) => {
      await rejectLocaleSettingsSave(patch, locale.controller, globalSync.data.config.locale)
    },
    discardChanges,
    closeDialog: () => props.onClose?.() ?? dialog.close(),
    showConfirm,
  })

  async function savePersonalizeChanges() {
    const saved = await personalizeController.save()
    if (!saved) {
      showToast({
        type: "error",
        title: _(copy.customInstructionsNotSaved),
        description: personalizeController.error() ?? _(copy.customInstructionsReview),
      })
      return false
    }
    showToast({
      type: "success",
      title: personalizeController.info()?.hasOverride
        ? _(copy.customInstructionsSaved)
        : _(copy.customInstructionsReset),
      description: personalizeController.info()?.hasOverride
        ? _(copy.customInstructionsOverride)
        : _(copy.customInstructionsGlobal),
    })
    return true
  }

  async function savePluginChanges() {
    return pluginDrafts.save(async (key, values) => {
      const result = await globalSDK.client.plugin.updateConfig({
        pluginId: key.pluginId,
        scopeID: key.scopeId,
        pluginConfigUpdate: values,
      })
      const saved = settingsValues(result.data, values)
      window.dispatchEvent(
        new CustomEvent("synergy:plugin-config-changed", {
          detail: { pluginId: key.pluginId, scopeId: key.scopeId, values: saved },
        }),
      )
      return saved
    })
  }

  async function saveFontChanges() {
    return font.save()
  }

  async function saveDesktopUpdateChanges() {
    const mode = desktopUpdateDraft()
    if (mode === undefined) return true
    const next = await productUpdate.setDesktopMode(mode)
    if (next?.mode !== mode) return false
    setDesktopUpdateDraft((current) => retainDraftAfterSave(current, mode))
    return true
  }

  async function saveDesktopZoomChanges() {
    const draft = desktopZoomDraft()
    const bridge = platform.desktopZoom
    if (draft === undefined || !bridge) return true
    const applied = await bridge.set(draft)
    if (Math.abs(applied - draft) > 1e-6) return false
    setDesktopZoomSaved(applied)
    setDesktopZoomDraft((current) => retainDraftAfterSave(current, draft))
    return true
  }

  const explicitSaveSources = () => [
    { dirty: save.explicitDirty, save: save.saveServerChanges },
    { dirty: hasPluginChanges, save: savePluginChanges },
    { dirty: personalizeController.dirty, save: savePersonalizeChanges },
    { dirty: font.dirty, save: saveFontChanges },
    { dirty: desktopUpdateDirty, save: saveDesktopUpdateChanges },
    { dirty: desktopZoomDirty, save: saveDesktopZoomChanges },
  ]
  const hasExplicitChanges = createMemo(() => hasExplicitSettingsChanges(explicitSaveSources()))
  const explicitSaveBlocked = createMemo(
    () =>
      saving() || personalizeController.busy() || (personalizeController.dirty() && !personalizeController.canSave()),
  )

  async function saveExplicitChanges() {
    setSaving(true)
    setAggregateSaveStatus("saving")
    try {
      const saved = await saveExplicitSettingsChanges(explicitSaveSources())
      setSaveResultFingerprint(draftFingerprint())
      setAggregateSaveStatus(saved ? "saved" : "error")
      if (!saved) {
        showToast({ type: "error", title: _(copy.partialSaveFailed), description: _(copy.partialSaveReview) })
      }
    } finally {
      setSaving(false)
    }
  }

  async function openDomain(domain: ConfigDomainSummary["id"]) {
    if (!canOpenConfigFiles()) return
    setOpeningDomain(domain)
    try {
      const res = await globalSDK.client.config.domain.open({ domain })
      showToast({
        type: "success",
        title: _(copy.configFileOpened),
        description: res.data?.path ?? domain,
      })
      await refetchDomains()
    } catch (error) {
      const filepath = domainSummaries()?.find((item) => item.id === domain)?.path ?? domain
      const failure = configFileOpenFailure(error, filepath)
      showToast({
        type: "error",
        title: translateDescriptor(failure.title, i18n()),
        description: translateDescriptor(failure.description, i18n()),
      })
    } finally {
      setOpeningDomain(undefined)
    }
  }

  function readDeveloperMode(): boolean {
    try {
      return localStorage.getItem(SETTINGS_DEVELOPER_MODE_STORAGE_KEY) === "true"
    } catch {
      return false
    }
  }

  function persistDeveloperMode(value: boolean) {
    try {
      if (value) {
        localStorage.setItem(SETTINGS_DEVELOPER_MODE_STORAGE_KEY, "true")
      } else {
        localStorage.removeItem(SETTINGS_DEVELOPER_MODE_STORAGE_KEY)
      }
    } catch {
      // localStorage unavailable — in-memory state only
    }
  }

  function toggleDeveloperMode() {
    const next = !developerMode()
    setDeveloperMode(next)
    persistDeveloperMode(next)
  }
  function stageDesktopUpdateMode(mode: DesktopUpdateMode) {
    const saved = productUpdate.desktopStatus()?.mode ?? "auto"
    setDesktopUpdateDraft(mode === saved ? undefined : mode)
  }
  function stageDesktopZoomFactor(factor: number) {
    const saved = desktopZoomSaved() ?? 1
    setDesktopZoomDraft(Math.abs(factor - saved) < 0.005 ? undefined : factor)
  }

  const saveFooterStatus = createMemo(() =>
    settingsSaveFooterStatus({
      saving: saving() || personalizeController.busy(),
      dirty: hasExplicitChanges(),
      resultCurrent: saveResultFingerprint() === draftFingerprint(),
      aggregate: aggregateSaveStatus(),
      server: save.status(),
      personalize: personalizeController.status(),
    }),
  )
  const canRefreshClarusProjects = (accountID: string) =>
    canRefreshChannelAccount(channelStatuses()?.[`clarus:${accountID}`])
  const refreshClarusProjects = async (accountID: string) => {
    if (!canRefreshClarusProjects(accountID)) return
    try {
      await globalSDK.client.channel.refreshProjects(
        { channelType: "clarus", accountId: accountID },
        { throwOnError: true },
      )
    } catch (error) {
      showToast({
        type: "error",
        title: _(copy.clarusRefreshFailed),
        description: requestErrorMessage(error, _(copy.clarusRefreshFailed)),
      })
    } finally {
      await Promise.resolve(refetchChannelStatuses()).catch(() => undefined)
    }
  }

  const downloadClarusDiagnostics = async (accountID: string) => {
    try {
      const response = await globalSDK.client.channel.downloadDiagnostics({
        channelType: "clarus",
        accountId: accountID,
      })
      const data = response.data
      if (!data) return
      const blob =
        data instanceof Blob
          ? data
          : new Blob([typeof data === "string" ? data : JSON.stringify(data, null, 2)], {
              type: "application/x-ndjson",
            })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = clarusDiagnosticsFilename()
      document.body.appendChild(anchor)
      anchor.click()
      document.body.removeChild(anchor)
      URL.revokeObjectURL(url)
    } catch (error) {
      showToast({
        type: "error",
        title: _(copy.clarusDiagnosticsFailed),
        description: error instanceof Error ? error.message : _(copy.clarusDiagnosticsFailed),
      })
    }
  }

  const builtinSettingsComponents = (): Partial<Record<string, Component>> => ({
    account: AccountPanel,
    personalize: () => <PersonalizePanel controller={personalizeController} />,
    general: () => (
      <GeneralPanel
        general={settings.general}
        onGeneralChange={(key, value) => {
          if (key === "colorScheme") {
            const scheme = value as ColorScheme
            theme.setColorScheme(scheme)
            setSettings("general", "colorScheme", scheme)
            return
          }
          if (key === "theme") {
            const themeValue = value as string
            theme.setThemeId(themeValue || "synergy")
            setSettings("general", "theme", themeValue)
            // Persist to server independently — fire-and-forget with error toast on failure.
            void globalSDK.client.config.domain
              .update({ domain: "general", configDomainUpdateInput: { config: { theme: themeValue } } })
              .catch((error) => {
                showToast({
                  type: "error",
                  title: _(copy.themeSaveFailed),
                  description: requestErrorMessage(error),
                })
              })
            return
          }
          setSettings("general", key, value)
        }}
        desktopUpdateMode={desktopUpdateDraft() ?? productUpdate.desktopStatus()?.mode}
        onDesktopUpdateModeChange={stageDesktopUpdateMode}
        desktopZoom={desktopZoomDraft() ?? desktopZoomSaved() ?? 1}
        onDesktopZoomChange={stageDesktopZoomFactor}
        popoverLayer={settingsPopoverLayer()}
      />
    ),
    models: () => (
      <ModelsPanel
        models={settings.models}
        savedModels={savedModels()}
        providerModels={providerModels}
        modelRoleSummaries={() => modelRoleSummaries() ?? []}
        roleVariant={settings.roleVariant}
        popoverLayer={settingsPopoverLayer()}
        onModelChange={(key, value) => setSettings("models", key, value)}
        onVariantChange={(roleId, variant) =>
          setSettings("roleVariant", roleId, variant || (undefined as unknown as string))
        }
        onQuickSwitcherChange={(preferences) => setSettings("models", "quick_switcher", preferences)}
        onConnectProvider={() => setActiveTab("providers")}
      />
    ),
    providers: () => (
      <ProvidersPanel
        summaries={providerSummaries()}
        authMethods={globalSync.data.provider_auth}
        providerFocusID={providerFocusID()}
      />
    ),
    github: GitHubPanel,
    "synergy-link": SynergyLinkPanel,
    usage: () => (
      <UsagePanel
        onConnectProvider={(providerID) => {
          setProviderFocusID(providerID)
          setActiveTab("providers")
        }}
      />
    ),
    learning: () => (
      <LearningPanel library={settings.library} onLibraryChange={(key, value) => setSettings("library", key, value)} />
    ),
    memory: () => (
      <MemoryPanel
        library={settings.library}
        embeddingConfigDirty={Boolean(serverPatch().embedding)}
        onLibraryChange={(key, value) => setSettings("library", key, value)}
      />
    ),
    experience: () => (
      <ExperiencePanel
        library={settings.library}
        onLibraryChange={(key, value) => setSettings("library", key, value)}
      />
    ),
    skills: () => (
      <SkillsPanel
        skills={settings.skills}
        sources={skillSources() ?? []}
        onSkillsChange={(source, value) => setSettings("skills", source, value)}
      />
    ),
    mcp: () => (
      <McpPanel
        entries={settings.mcps.entries}
        onAdd={() => setSettings("mcps", "entries", (prev) => [...prev, emptyMcp()])}
        onChange={(index, field, value) =>
          setSettings("mcps", "entries", index, field as keyof McpEntry, value as never)
        }
        onRemove={(index) =>
          setSettings(
            "mcps",
            "entries",
            produce((draft) => {
              draft.splice(index, 1)
            }),
          )
        }
      />
    ),

    channels: () => (
      <ChannelsPanel
        channels={settings.channels}
        providers={providerGroups()}
        popoverLayer={settingsPopoverLayer()}
        clarusAccountName={(accountID) => clarusAccountDisplayName(accountID, holos.state.identity.accounts)}
        clarusAccountDescription={(accountID) =>
          translateDescriptor(channelRuntimeStatusLabel(channelStatuses()?.[`clarus:${accountID}`]), i18n())
        }
        canRefreshClarusAccount={canRefreshClarusProjects}
        onFeishuToggle={(index, value) => setSettings("channels", "feishuAccounts", index, "enabled", value)}
        onFeishuModelChange={(index, model) => setSettings("channels", "feishuAccounts", index, "model", model)}
        onFeishuVariantChange={(index, variant) => setSettings("channels", "feishuAccounts", index, "variant", variant)}
        onClarusToggle={(index, value) => setSettings("channels", "clarusAccounts", index, "enabled", value)}
        onClarusRefresh={refreshClarusProjects}
        onClarusDiagnostics={downloadClarusDiagnostics}
        onGithubToggle={(index, value) => setSettings("channels", "githubAccounts", index, "enabled", value)}
        onGithubFieldChange={(index, field, value) =>
          setSettings("channels", "githubAccounts", index, field, value as never)
        }
      />
    ),
    email: () => (
      <EmailPanel email={settings.email} onEmailChange={(key, value) => setSettings("email", key, value as never)} />
    ),
    permissions: () => (
      <PermissionsPanel safety={settings.safety} onSafetyChange={(key, value) => setSettings("safety", key, value)} />
    ),
    sandbox: () => (
      <SandboxPanel
        safety={settings.safety}
        sandboxStatus={sandboxStatus()}
        onSafetyChange={(key, value) => setSettings("safety", key, value)}
      />
    ),
    "control-profile": () => (
      <ControlProfilePanel
        safety={settings.safety}
        controlProfiles={controlProfiles() ?? []}
        onSafetyChange={(key, value) => setSettings("safety", key, value)}
      />
    ),
    questions: () => (
      <QuestionsPanel runtime={settings.runtime} onRuntimeChange={(key, value) => setSettings("runtime", key, value)} />
    ),
    compaction: () => (
      <CompactionPanel
        runtime={settings.runtime}
        onRuntimeChange={(key, value) => setSettings("runtime", key, value)}
      />
    ),
    timeouts: () => (
      <TimeoutsPanel
        runtime={settings.runtime}
        onRuntimeChange={(key, value) => setSettings("runtime", key, value)}
        availableAgents={(agents() ?? []).filter((a) => a.mode === "primary" && !a.hidden)}
        defaultAgent={settings.agents.defaultAgent}
        onDefaultAgentChange={(agent) => setSettings("agents", "defaultAgent", agent)}
        concurrencyStatus={cortexConcurrencyStatus()}
        configuredAgentWorkers={config()?.execution?.agentWorkers}
        popoverLayer={settingsPopoverLayer()}
      />
    ),
    "code-checks": () => (
      <CodeChecksPanel
        runtime={settings.runtime}
        onRuntimeChange={(key, value) => setSettings("runtime", key, value)}
        popoverLayer={settingsPopoverLayer()}
      />
    ),
    formatter: () => referencePanel(_(copy.formatterTitle), _(copy.formatterDescription), ["runtime"]),
    lsp: () => referencePanel(_(copy.lspTitle), _(copy.lspDescription), ["runtime"]),
    observability: () => (
      <ObservabilityPanel
        runtime={settings.runtime}
        shellEnvironment={desktopServerStatus()?.shellEnvironment}
        onRuntimeChange={(key, value) => setSettings("runtime", key, value)}
      />
    ),
    boss: () => (
      <BossModePanel runtime={settings.runtime} onRuntimeChange={(key, value) => setSettings("runtime", key, value)} />
    ),
    import: () => (
      <ImportPanel
        domains={domainSummaries() ?? []}
        scopes={globalSync.data.scope}
        onImported={(changedFields) => refreshAfterConfigChange(changedFields, undefined)}
        popoverLayer={settingsPopoverLayer()}
      />
    ),
    "config-files": () => (
      <ConfigFilesPanel
        domains={domainSummaries() ?? []}
        openingDomain={openingDomain()}
        onOpenDomain={canOpenConfigFiles() ? (domain) => void openDomain(domain) : undefined}
      />
    ),
    "archived-sessions": () => <ArchivedSessionsPanel popoverLayer={settingsPopoverLayer()} />,
    worktrees: WorktreesPanel,
  })

  const settingsSections = createMemo(() => {
    settingsRegistryVersion()
    const components = builtinSettingsComponents()
    const desktopZoom = Boolean(platform.desktopZoom)
    return filterSettingsSections(getSettingsSections(), developerMode())
      .map((section) => {
        const localized = localizeSettingsSection(section, _)
        const base = isBuiltinSettingsId(section.id) ? { ...localized, component: components[section.id] } : localized
        if (!desktopZoom || section.id !== "general") return base
        const zoomLabel = _(copy.interfaceZoomRow)
        return {
          ...base,
          keywords: [...(base.keywords ?? []), zoomLabel.toLowerCase()],
          rowLabels: [...(base.rowLabels ?? []), zoomLabel],
        }
      })
      .sort(compareSections)
  })

  const filteredSections = createMemo(() => {
    const query = normalizeSearch(search())
    if (!query) return settingsSections()
    const terms = query.split(/\s+/).filter(Boolean)
    return settingsSections().filter((section) => {
      const haystack = normalizeSearch(
        [
          section.label,
          section.group,
          section.description,
          ...(section.keywords ?? []),
          ...(section.domainIds ?? []),
          ...(section.rowLabels ?? []),
        ].join(" "),
      )
      return terms.every((term) => haystack.includes(term))
    })
  })

  const navGroups = createMemo(() => {
    const map = new Map<string, { label: string; sections: RegisteredSettingsSection[] }>()
    for (const section of filteredSections()) {
      const key = settingsSectionGroupKey(section) || "Plugins"
      const label = section.group || _(copy.pluginsGroup)
      const group = map.get(key)
      if (group) group.sections.push(section)
      else map.set(key, { label, sections: [section] })
    }
    return [...map.entries()]
      .sort(([a], [b]) => settingsGroupOrder(a) - settingsGroupOrder(b) || a.localeCompare(b))
      .map(([, group]) => ({ ...group, sections: group.sections.sort(compareSections) }))
  })

  const domainMap = createMemo(() => new Map((domainSummaries() ?? []).map((domain) => [domain.id, domain])))
  const domainsFor = (ids: string[] | undefined) =>
    (ids ?? []).flatMap((id) => {
      const domain = domainMap().get(id as ConfigDomainSummary["id"])
      return domain ? [domain] : []
    })

  createEffect(() => {
    const desktop = isDesktop()
    setNavigation((state) => reduceSettingsMobileNavigation(state, { type: "layout", desktop }))
  })

  const activeSection = createMemo(() => settingsSections().find((section) => section.id === activeTab()))

  const selectSection = (id: string) => setActiveTab(id)

  createEffect(() => {
    if (!ready()) return
    const sectionIDs = settingsSections().map((section) => section.id)
    setNavigation((state) => reduceSettingsMobileNavigation(state, { type: "validate", sectionIDs }))
  })

  createEffect(() => {
    if (!ready() || isDesktop() || !mobileDetailOpen()) return
    queueMicrotask(() => mobileBackButton?.focus())
  })

  return (
    <div class="settings-panel-frame">
      <button type="button" class="settings-panel-close" aria-label={_(copy.closeLabel)} onClick={save.closeWithGuard}>
        <Icon name={getSemanticIcon("action.close")} size="small" />
      </button>
      {ready() ? (
        <AppPanel.Root class="settings-panel-root">
          <AppPanel.Nav
            ref={(element) => (settingsNavigation = element)}
            class={`settings-panel-navigation ${!isDesktop() && mobileDetailOpen() ? "settings-panel-mobile-hidden" : ""}`}
          >
            <div class="settings-panel-navigation-header px-3 pt-4 pb-2 flex flex-col gap-2">
              <div>
                <div class="settings-nav-title truncate">{_(copy.globalConfig)}</div>
                <div class="flex items-center gap-1.5 flex-wrap">
                  <Show when={saveFooterStatus() === "error"}>
                    <span class="settings-nav-badge settings-nav-badge-error">{_(copy.errorBadge)}</span>
                  </Show>
                  <Show when={saveFooterStatus() === "dirty"}>
                    <span class="settings-nav-badge settings-nav-badge-dirty">{_(copy.unsavedBadge)}</span>
                  </Show>
                  <Show when={saveFooterStatus() === "saving"}>
                    <span class="settings-nav-badge settings-nav-badge-saving">{_(copy.savingBadge)}</span>
                  </Show>
                  <Show when={saveFooterStatus() === "saved"}>
                    <span class="settings-nav-badge settings-nav-badge-saved">{_(copy.savedBadge)}</span>
                  </Show>
                  <Show when={developerMode()}>
                    <span class="settings-nav-badge settings-nav-badge-dev">{_(copy.developerBadge)}</span>
                  </Show>
                </div>
              </div>
              <div class="ds-settings-search">
                <Icon name={getSemanticIcon("action.search")} size="small" />
                <input
                  value={search()}
                  placeholder={_(copy.searchPlaceholder)}
                  onInput={(event) => setSearch(event.currentTarget.value)}
                />
              </div>
            </div>

            <div class="flex-1 overflow-y-auto px-2 pb-3">
              <For each={navGroups()}>
                {(group) => (
                  <AppPanel.NavSection label={group.label}>
                    <For each={group.sections}>
                      {(section) => (
                        <AppPanel.NavItem
                          icon={sectionIcon(section)}
                          label={section.label}
                          active={activeTab() === section.id}
                          onClick={() => selectSection(section.id)}
                        />
                      )}
                    </For>
                  </AppPanel.NavSection>
                )}
              </For>
              <Show when={navGroups().length === 0}>
                <div class="settings-empty-text px-3 py-6 text-text-weaker">{_(copy.noSettings)}</div>
              </Show>
            </div>
          </AppPanel.Nav>

          <AppPanel.Content
            class={`settings-panel-content ${!isDesktop() && !mobileDetailOpen() ? "settings-panel-mobile-hidden" : ""}`}
          >
            <div class="settings-panel-mobile-detail-header">
              <button
                ref={mobileBackButton}
                type="button"
                class="settings-panel-mobile-back flex shrink-0 items-center justify-center rounded-lg text-icon-weak-base hover:bg-surface-raised-base-hover hover:text-icon-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-focus-base"
                aria-label={_(copy.backLabel)}
                onClick={showMobileSectionList}
              >
                <Icon name={getSemanticIcon("navigation.back")} size="small" />
              </button>
              <div class="min-w-0 truncate text-15-medium text-text-strong">{activeSection()?.label}</div>
            </div>
            <Show when={(configDiagnostics()?.length ?? 0) > 0}>
              <div class="settings-config-diagnostics-banner" role="alert">
                <div class="settings-config-diagnostics-title">{_(copy.configDiagnosticsTitle)}</div>
                <div class="settings-config-diagnostics-description">{_(copy.configDiagnosticsDescription)}</div>
                <ul class="settings-config-diagnostics-list">
                  <For each={configDiagnostics()}>
                    {(issue) => (
                      <li>
                        {_({
                          ...copy.configDiagnosticsDetail,
                          values: { path: issue.path, error: issue.error },
                        })}
                        <Show when={issue.quarantinedPath}>
                          {_({
                            ...copy.configDiagnosticsQuarantined,
                            values: { path: issue.quarantinedPath! },
                          })}
                        </Show>
                      </li>
                    )}
                  </For>
                </ul>
              </div>
            </Show>
            <AppPanel.Body padding={false}>
              {renderActiveContent()}
              <SlotOutlet slot="settings.section" />
            </AppPanel.Body>

            <AppPanel.Footer class="settings-panel-footer">
              <div class="settings-panel-footer-status flex flex-1 items-center gap-3">
                <SaveIndicator status={saveFooterStatus()} />
                <button
                  type="button"
                  class="settings-dev-toggle"
                  onClick={toggleDeveloperMode}
                  aria-pressed={developerMode()}
                >
                  <Icon name={getSemanticIcon("settings.diagnostics")} size="small" />
                  <span>{_(copy.developerMode)}</span>
                </button>
              </div>
              <div class="settings-panel-footer-actions">
                <Button type="button" variant="ghost" size="large" onClick={save.closeWithGuard}>
                  {_(copy.cancel)}
                </Button>
                <Show when={hasExplicitChanges()}>
                  <Button
                    type="button"
                    variant="primary"
                    size="large"
                    disabled={explicitSaveBlocked()}
                    onClick={() => void saveExplicitChanges()}
                  >
                    {saving() ? _(copy.saving) : _(copy.saveChanges)}
                  </Button>
                </Show>
              </div>
            </AppPanel.Footer>
          </AppPanel.Content>
        </AppPanel.Root>
      ) : (
        <div class="settings-panel-loading">{_(copy.loading)}</div>
      )}
      <div class="settings-popover-layer" ref={setSettingsPopoverLayer} />
    </div>
  )

  function renderActiveContent(): JSX.Element {
    const section = activeSection()
    if (!section) {
      return (
        <SettingsPage title={_(copy.emptyTitle)} description={_(copy.emptyDescription)}>
          <SettingsSection>
            <div class="ds-empty-state">{_(copy.noSection)}</div>
          </SettingsSection>
        </SettingsPage>
      )
    }
    return <SettingsSectionContent section={section} drafts={pluginDrafts} draftVersion={pluginDraftVersion} />
  }

  function referencePanel(title: string, description: string, domainIds: string[]) {
    return (
      <ConfigReferencePanel
        title={title}
        description={description}
        domains={domainsFor(domainIds)}
        openingDomain={openingDomain()}
        onOpenDomain={canOpenConfigFiles() ? (domain) => void openDomain(domain) : undefined}
      />
    )
  }
}

// Host-side settings component props: the trusted context is present only for plugin
// sections (built-in panels do not receive it). The public plugin contract keeps
// `context` required; this host-side type reflects what the renderer actually passes.
type SettingsHostComponentProps = Omit<PluginSettingsComponentProps, "context"> & {
  context?: PluginSettingsSurfaceContext
}

function SettingsSectionContent(props: {
  section: RegisteredSettingsSection
  drafts: ReturnType<typeof createPluginSettingsDrafts>
  draftVersion: () => number
}) {
  const globalSDK = useGlobalSDK()
  const { _ } = useLingui()
  const componentLoader = createSettingsComponentLoader<Component<SettingsHostComponentProps>>()
  const comp = componentLoader.component
  const loading = componentLoader.loading

  const section = () => props.section
  const [values, { mutate }] = createResource(
    () => pluginSettingsResourceKey(section()),
    async (key) => {
      const result = await globalSDK.client.plugin.getConfig({ pluginId: key.pluginId, scopeID: key.scopeId })
      return props.drafts.adopt(key, settingsValues(result.data))
    },
  )

  function updateValues(next: Record<string, unknown>) {
    const key = pluginSettingsResourceKey(section())
    if (!key) return
    props.drafts.stage(key, next)
    mutate(next)
  }

  createEffect(() => {
    props.draftVersion()
    const key = pluginSettingsResourceKey(section())
    if (!key) return
    const draft = props.drafts.values(key)
    if (draft) mutate(draft)
  })

  createEffect(() => {
    const current = section()
    void componentLoader.load({
      component: current.component as Component<SettingsHostComponentProps> | undefined,
      loader: current.loader as (() => Promise<{ default: Component<SettingsHostComponentProps> }>) | undefined,
    })
  })

  return (
    <Show
      when={!loading()}
      fallback={
        <div class="flex items-center justify-center py-8">
          <Spinner class="size-5" />
        </div>
      }
    >
      <Show when={!section().pluginId || values()}>
        <Show
          when={comp()}
          fallback={
            <Show
              when={section().formSchema}
              fallback={
                <div class="settings-availability-message flex items-center justify-center py-8">
                  {_({ ...copy.sectionUnavailable, values: { label: section().label } })}
                </div>
              }
            >
              {(schema) => (
                <SettingsPage title={section().label}>
                  <SettingsSection>
                    <DeclarativeSettingsForm
                      schema={schema()}
                      values={(values() ?? {}) as Record<string, unknown>}
                      onChange={(next) => updateValues(next)}
                    />
                  </SettingsSection>
                </SettingsPage>
              )}
            </Show>
          }
        >
          {(c) => (
            <ErrorBoundary
              fallback={(error) => (
                <div class="settings-availability-message flex items-center justify-center py-8 text-icon-critical-base">
                  {error.message}
                </div>
              )}
            >
              <Dynamic
                component={c()}
                {...(section().context ? { context: section().context } : {})}
                pluginId={section().pluginId}
                values={(values() ?? {}) as Record<string, unknown>}
                onChange={(next: Record<string, unknown>) => updateValues(next)}
              />
            </ErrorBoundary>
          )}
        </Show>
      </Show>
    </Show>
  )
}

function normalizeInitialTab(id: string | undefined) {
  if (!id) return "general"
  return legacyInitialTabs[id] ?? id
}

function compareSections(a: RegisteredSettingsSection, b: RegisteredSettingsSection) {
  return (a.order ?? 0) - (b.order ?? 0) || a.label.localeCompare(b.label)
}

function normalizeSearch(value: string) {
  return value.trim().toLowerCase()
}

function sectionIcon(section: RegisteredSettingsSection): IconName {
  if (section.iconToken) return getSemanticIcon(section.iconToken)
  return (section.icon ?? getSemanticIcon("settings.general")) as IconName
}
