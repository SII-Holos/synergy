import {
  ErrorBoundary,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  onMount,
  Show,
  type Component,
  type JSX,
} from "solid-js"
import { createStore, produce } from "solid-js/store"
import { Dynamic } from "solid-js/web"
import { useLingui } from "@lingui/solid"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon, type IconName } from "@ericsanchezok/synergy-ui/icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import type {
  ConfigDomainSummary,
  ControlProfileSummary,
  CortexConcurrencyStatus,
  ModelRoleSummary,
  SandboxStatus,
} from "@ericsanchezok/synergy-sdk/client"
import { useGlobalSDK } from "@/context/global-sdk"
import { useInput } from "@/context/input"
import { useGlobalSync } from "@/context/global-sync"
import { usePlatform } from "@/context/platform"
import { useLocale } from "@/context/locale"
import { useConfirm, type ConfirmOptions } from "@/components/dialog/confirm-dialog"
import { getSettingsSections, type SettingsSection as RegisteredSettingsSection } from "@/plugin"
import { DeclarativeSettingsForm } from "@/plugin/components/declarative-settings-form"
import { AppPanel } from "@/components/app-panel"
import { translateDescriptor } from "@/locales/translate"
import "./settings-panel.css"
import type { DialogSettingsProps, McpEntry, ModelsStore, ProviderGroup, ProviderModel, SettingsState } from "./types"
import { defaultSettingsState, emptyMcp, groupByProvider } from "./types"
import { isBuiltinSettingsId, settingsGroupOrder } from "./catalog"
import { ensureInit } from "./hooks/useSettingsForm"
import { buildPatch } from "./hooks/useConfigPatch"
import { useSettingsSave } from "./hooks/useSettingsSave"
import { hasExplicitSettingsChanges, saveExplicitSettingsChanges } from "./settings-explicit-save"
import { GeneralPanel } from "./panels/GeneralPanel"
import { rollbackFailedLocalePatch } from "./panels/locale-preference-change"
import { ModelsPanel } from "./panels/ModelsPanel"
import { ProvidersPanel } from "./panels/ProvidersPanel"
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
import { CodeChecksPanel } from "./panels/CodeChecksPanel"
import { SettingsPage, SettingsSection } from "./components/SettingsPrimitives"
import { filterSettingsSections, SETTINGS_DEVELOPER_MODE_STORAGE_KEY } from "./settings-visibility"
import { SaveIndicator } from "./components/SaveIndicator"
import { canUseConfigFileOpen, configFileOpenFailure } from "./config-file-open-model"
import { localizeSettingsSection, settingsSectionGroupKey } from "./settings-section-copy"

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
}

export type SettingsPanelProps = DialogSettingsProps & {
  onClose?: () => void
}

export function SettingsDialog(props: DialogSettingsProps) {
  const dialog = useDialog()
  const { _ } = useLingui()
  return (
    <Dialog ariaLabel={_(copy.dialogLabel)} class="settings-dialog-panel">
      <SettingsPanel {...props} onClose={() => dialog.close()} />
    </Dialog>
  )
}

export function SettingsPanel(props: SettingsPanelProps) {
  const { _, i18n } = useLingui()
  const dialog = useDialog()
  const confirm = useConfirm()
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const input = useInput()
  const platform = usePlatform()
  const locale = useLocale()
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

  const [activeTab, setActiveTab] = createSignal(normalizeInitialTab(props.initialTab))
  const [providerFocusID, setProviderFocusID] = createSignal(props.providerFocusID)
  const [search, setSearch] = createSignal("")
  const [initialized, setInitialized] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const [refreshing, setRefreshing] = createSignal(false)
  const [openingDomain, setOpeningDomain] = createSignal<string | undefined>()
  const [settingsPopoverLayer, setSettingsPopoverLayer] = createSignal<HTMLElement>()
  const [developerMode, setDeveloperMode] = createSignal(readDeveloperMode())

  const [settings, setSettings] = createStore<SettingsState>(defaultSettingsState(input.sendShortcut()))

  const [config, { refetch: refetchConfig }] = createResource(async () => {
    const res = await globalSDK.client.config.global()
    return res.data!
  })

  const [cortexConcurrencyStatus, { refetch: refetchCortexConcurrencyStatus }] = createResource(async () => {
    const res = await globalSDK.client.cortex.concurrency()
    return res.data as CortexConcurrencyStatus | undefined
  })

  const [domainSummaries, { refetch: refetchDomains }] = createResource(async () => {
    const res = await globalSDK.client.config.domain.list()
    return res.data ?? []
  })

  const [desktopServerStatus] = createResource(async () => {
    if (platform.platform !== "desktop" || !platform.desktopServer) return null
    return platform.desktopServer.status().catch(() => null)
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

  const providerModels = createMemo(() => {
    const data = globalSync.data.provider
    const list: ProviderModel[] = []
    for (const provider of data.all) {
      if (!data.connected.includes(provider.id)) continue
      if (data.runtimeAvailability?.[provider.id]?.available === false) continue
      for (const [modelId, model] of Object.entries(provider.models) as [
        string,
        { name: string; variants?: Record<string, unknown> },
      ][]) {
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
    return data.all.map((provider) => {
      const health = data.authHealth?.[provider.id]
      const availability = data.runtimeAvailability?.[provider.id]
      return {
        id: provider.id,
        name: provider.name,
        connected: data.connected.includes(provider.id),
        modelCount: availability?.modelCount ?? Object.keys(provider.models).length,
        health,
        availability,
        profile: data.profiles?.[provider.id],
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
  const cancelDebouncesRef = { current: () => {} }

  function resetEditor() {
    setInitialized(false)
    initializedForSet = undefined
  }

  async function refreshAfterConfigChange() {
    cancelDebouncesRef.current()
    setRefreshing(true)
    resetEditor()
    await globalSync.refreshAllConfigs()
    await Promise.all([
      refetchConfig(),
      refetchDomains(),
      refetchModelRoleSummaries(),
      refetchAgents(),
      refetchCortexConcurrencyStatus(),
    ])
    setRefreshing(false)
    doEnsureInit()
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
  const editingLabel = createMemo(() => _(copy.globalConfig))
  const hasAnyChanges = createMemo(() => hasServerChanges() || personalizeController.dirty())

  function showConfirm(params: ConfirmOptions) {
    confirm.show(params)
  }

  const save = useSettingsSave({
    serverPatch,
    domainSummaries: () => domainSummaries() ?? [],
    hasAnyChanges,
    editingLabel,
    setSaving,
    refreshAfterConfigChange,
    onPatchFailed: async (patch) => {
      const authoritativePreference = config()?.locale
      const rolledBack = await rollbackFailedLocalePatch({
        patch,
        authoritativePreference,
        controller: locale.controller,
      })
      if (rolledBack) setSettings("general", "locale", authoritativePreference ?? "system")
    },
    closeDialog: () => props.onClose?.() ?? dialog.close(),
    showConfirm,
  })
  cancelDebouncesRef.current = save.cancelDebounces

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

  const explicitSaveSources = () => [
    { dirty: save.explicitDirty, save: save.saveServerChanges },
    { dirty: personalizeController.dirty, save: savePersonalizeChanges },
  ]
  const hasExplicitChanges = createMemo(() => hasExplicitSettingsChanges(explicitSaveSources()))
  const explicitSaveBlocked = createMemo(
    () =>
      saving() || personalizeController.busy() || (personalizeController.dirty() && !personalizeController.canSave()),
  )

  async function saveExplicitChanges() {
    await saveExplicitSettingsChanges(explicitSaveSources(), () => props.onClose?.() ?? dialog.close())
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

  const saveFooterStatus = createMemo<"idle" | "saving" | "saved" | "error" | "dirty">(() => {
    if (save.autoStatus() === "error" || save.bgStatus() === "error" || personalizeController.status() === "error")
      return "error"
    if (save.autoStatus() === "saving" || save.bgStatus() === "saving" || saving() || personalizeController.busy())
      return "saving"
    if (save.autoStatus() === "saved" || save.bgStatus() === "saved") return "saved"
    if (save.explicitDirty() || personalizeController.dirty()) return "dirty"
    return "idle"
  })
  const builtinSettingsComponents = (): Partial<Record<string, Component>> => ({
    account: AccountPanel,
    personalize: () => <PersonalizePanel controller={personalizeController} />,
    general: () => (
      <GeneralPanel general={settings.general} onGeneralChange={(key, value) => setSettings("general", key, value)} />
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
        onChannelToggle={(index, value) => setSettings("channels", "feishuAccounts", index, "enabled", value)}
        onChannelModelChange={(index, model) => setSettings("channels", "feishuAccounts", index, "model", model)}
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
      />
    ),
    "code-checks": () => (
      <CodeChecksPanel
        runtime={settings.runtime}
        onRuntimeChange={(key, value) => setSettings("runtime", key, value)}
      />
    ),
    formatter: () => referencePanel(_(copy.formatterTitle), _(copy.formatterDescription), ["runtime"]),
    lsp: () => referencePanel(_(copy.lspTitle), _(copy.lspDescription), ["runtime"]),
    observability: () => (
      <ObservabilityPanel
        runtime={settings.runtime}
        onRuntimeChange={(key, value) => setSettings("runtime", key, value)}
      />
    ),
    import: () => (
      <ImportPanel
        domains={domainSummaries() ?? []}
        scopes={globalSync.data.scope}
        onImported={refreshAfterConfigChange}
      />
    ),
    "config-files": () => (
      <ConfigFilesPanel
        domains={domainSummaries() ?? []}
        openingDomain={openingDomain()}
        onOpenDomain={canOpenConfigFiles() ? (domain) => void openDomain(domain) : undefined}
      />
    ),
    "archived-sessions": ArchivedSessionsPanel,
    worktrees: WorktreesPanel,
  })

  const settingsSections = createMemo(() => {
    const components = builtinSettingsComponents()
    return filterSettingsSections(getSettingsSections(), developerMode())
      .map((section) => {
        const localized = localizeSettingsSection(section, _)
        return isBuiltinSettingsId(section.id) ? { ...localized, component: components[section.id] } : localized
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
    if (!ready()) return
    const current = activeTab()
    if (settingsSections().some((section) => section.id === current)) return
    setActiveTab("general")
  })

  return (
    <div class="settings-panel-frame">
      <button type="button" class="settings-panel-close" aria-label={_(copy.closeLabel)} onClick={save.closeWithGuard}>
        <Icon name={getSemanticIcon("action.close")} size="small" />
      </button>
      {ready() ? (
        <AppPanel.Root class="settings-panel-root">
          <AppPanel.Nav>
            <div class="px-3 pt-4 pb-2 flex flex-col gap-2">
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
                          onClick={() => setActiveTab(section.id)}
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

          <AppPanel.Content>
            <AppPanel.Body padding={false}>{renderActiveContent()}</AppPanel.Body>

            <AppPanel.Footer>
              <div class="flex-1 flex items-center gap-3">
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
                  {saving() || personalizeController.status() === "saving" ? _(copy.saving) : _(copy.saveChanges)}
                </Button>
              </Show>
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
    const section = settingsSections().find((item) => item.id === activeTab())
    if (!section) {
      return (
        <SettingsPage title={_(copy.emptyTitle)} description={_(copy.emptyDescription)}>
          <SettingsSection>
            <div class="ds-empty-state">{_(copy.noSection)}</div>
          </SettingsSection>
        </SettingsPage>
      )
    }
    return <SettingsSectionContent section={section} />
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

type SettingsComponentProps = {
  pluginId?: string
  values: Record<string, unknown>
  onChange: (values: Record<string, unknown>) => void | Promise<void>
}

function SettingsSectionContent(props: { section: RegisteredSettingsSection }) {
  const globalSDK = useGlobalSDK()
  const { _ } = useLingui()
  const [comp, setComp] = createSignal<Component<SettingsComponentProps> | null>(null)
  const [loading, setLoading] = createSignal(true)

  const section = () => props.section
  const [values, { mutate }] = createResource(
    () => section().pluginId,
    async (pluginId) => {
      const result = await globalSDK.client.plugin.getConfig({ pluginId })
      return result.data ?? {}
    },
  )

  async function updateValues(next: Record<string, unknown>) {
    const pluginId = section().pluginId
    if (!pluginId) return
    const result = await globalSDK.client.plugin.updateConfig({ pluginId, pluginConfigUpdate: next })
    const saved = result.data ?? next
    mutate(saved)
    window.dispatchEvent(new CustomEvent("synergy:plugin-config-changed", { detail: { pluginId, values: saved } }))
  }

  onMount(() => {
    const s = section()
    if (s.component) {
      setComp(() => s.component! as Component<SettingsComponentProps>)
      setLoading(false)
      return
    }
    if (s.loader) {
      s.loader().then(
        (mod) => {
          setComp(() => mod.default as Component<SettingsComponentProps>)
          setLoading(false)
        },
        () => setLoading(false),
      )
      return
    }
    setLoading(false)
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
