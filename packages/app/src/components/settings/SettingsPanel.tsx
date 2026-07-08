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
  ModelRoleSummary,
  SandboxStatus,
} from "@ericsanchezok/synergy-sdk/client"
import { useGlobalSDK } from "@/context/global-sdk"
import { useInput, type SendShortcut } from "@/context/input"
import { useGlobalSync } from "@/context/global-sync"
import { useConfirm, type ConfirmOptions } from "@/components/dialog/confirm-dialog"
import { getSettingsSections, type SettingsSection as RegisteredSettingsSection } from "@/plugin"
import { SandboxIframe } from "@/plugin/sandbox"
import { DeclarativeSettingsForm } from "@/plugin/components/declarative-settings-form"
import { AppPanel } from "@/components/app-panel"
import "./settings-panel.css"
import type { DialogSettingsProps, McpEntry, ModelsStore, ProviderGroup, ProviderModel, SettingsState } from "./types"
import { defaultSettingsState, emptyMcp, groupByProvider } from "./types"
import { BUILTIN_SETTINGS_IDS, isBuiltinSettingsId, settingsGroupOrder } from "./catalog"
import { ensureInit } from "./hooks/useSettingsForm"
import { buildPatch } from "./hooks/useConfigPatch"
import { useSettingsSave } from "./hooks/useSettingsSave"
import { GeneralPanel } from "./panels/GeneralPanel"
import { ModelsPanel } from "./panels/ModelsPanel"
import { ProvidersPanel } from "./panels/ProvidersPanel"
import { AccountPanel } from "./panels/AccountPanel"
import { UsagePanel } from "./panels/UsagePanel"
import { GitHubPanel } from "./panels/GitHubPanel"
import { McpPanel } from "./panels/McpPanel"
import { LearningPanel, MemoryPanel, ExperiencePanel } from "./panels/LibraryPanels"
import { ChannelsPanel } from "./panels/ChannelsPanel"
import { EmailPanel } from "./panels/EmailPanel"
import { ImportPanel } from "./panels/ImportPanel"
import { ConfigFilesPanel, ConfigReferencePanel } from "./panels/ConfigFilesPanel"
import { ControlProfilePanel, PermissionsPanel, SandboxPanel } from "./panels/SafetyPanels"
import { CompactionPanel, QuestionsPanel, TimeoutsPanel, ObservabilityPanel } from "./panels/RuntimePanels"
import { SettingsPage, SettingsSection } from "./components/SettingsPrimitives"
import { filterSettingsSections, SETTINGS_DEVELOPER_MODE_STORAGE_KEY } from "./settings-visibility"
import { SaveIndicator } from "./components/SaveIndicator"

const legacyInitialTabs: Record<string, string> = {
  advanced: "control-profile",
  appearance: "general",
  holos: "account",
  library: "learning",
  profile: "account",
}

export type SettingsPanelProps = DialogSettingsProps & {
  onClose?: () => void
}

export function SettingsDialog(props: DialogSettingsProps) {
  const dialog = useDialog()
  return (
    <Dialog class="settings-dialog-panel">
      <SettingsPanel {...props} onClose={() => dialog.close()} />
    </Dialog>
  )
}

export function SettingsPanel(props: SettingsPanelProps) {
  const dialog = useDialog()
  const confirm = useConfirm()
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const input = useInput()

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

  const [domainSummaries, { refetch: refetchDomains }] = createResource(async () => {
    const res = await globalSDK.client.config.domain.list()
    return res.data ?? []
  })

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
        available: availability?.available ?? data.connected.includes(provider.id),
        modelCount: availability?.modelCount ?? Object.keys(provider.models).length,
        authStatus: health?.status,
        availabilityReason: availability?.reason,
        reloginRequired: health?.reloginRequired,
        cooldownUntil: health?.cooldownUntil,
        resetAt: health?.resetAt,
        failureCode: health?.failureCode,
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

  const ready = () => initialized() && !!domainSummaries() && !!modelRoleSummaries()
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
    await Promise.all([refetchConfig(), refetchDomains(), refetchModelRoleSummaries(), refetchAgents()])
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
  const editingLabel = createMemo(() => "Global Config")
  const hasAnyChanges = createMemo(() => hasServerChanges())

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
    closeDialog: () => props.onClose?.() ?? dialog.close(),
    showConfirm,
  })
  cancelDebouncesRef.current = save.cancelDebounces

  function handleLocalSendShortcut(value: SendShortcut) {
    setSettings("general", "sendShortcut", value)
    if (value !== input.sendShortcut()) {
      input.setSendShortcut(value)
      showToast({
        type: "info",
        title: "Send shortcut updated",
        description: "This device preference is saved immediately.",
      })
    }
  }

  async function openDomain(domain: ConfigDomainSummary["id"]) {
    setOpeningDomain(domain)
    try {
      const res = await globalSDK.client.config.domain.open({ domain })
      showToast({
        type: "success",
        title: "Config file opened",
        description: res.data?.path ?? domain,
      })
      await refetchDomains()
    } catch (error: any) {
      showToast({ type: "error", title: "Open file failed", description: error.message })
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
    if (save.autoStatus() === "error" || save.bgStatus() === "error") return "error"
    if (save.autoStatus() === "saving" || save.bgStatus() === "saving" || saving()) return "saving"
    if (save.autoStatus() === "saved" || save.bgStatus() === "saved") return "saved"
    if (save.explicitDirty()) return "dirty"
    return "idle"
  })
  const settingsSections = createMemo(() =>
    filterSettingsSections(getSettingsSections(), developerMode()).sort(compareSections),
  )

  const pluginSections = createMemo(() => settingsSections().filter((section) => !isBuiltinSettingsId(section.id)))

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
    const map = new Map<string, RegisteredSettingsSection[]>()
    for (const section of filteredSections()) {
      const group = section.group || "Plugins"
      map.set(group, [...(map.get(group) ?? []), section])
    }
    return [...map.entries()]
      .sort(([a], [b]) => settingsGroupOrder(a) - settingsGroupOrder(b) || a.localeCompare(b))
      .map(([label, sections]) => ({ label, sections: sections.sort(compareSections) }))
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
      <button type="button" class="settings-panel-close" aria-label="Close settings" onClick={save.closeWithGuard}>
        <Icon name={getSemanticIcon("action.close")} size="small" />
      </button>
      {ready() ? (
        <AppPanel.Root class="settings-panel-root">
          <AppPanel.Nav>
            <div class="px-3 pt-4 pb-2 flex flex-col gap-2">
              <div>
                <div class="settings-nav-title truncate">Global Config</div>
                <div class="flex items-center gap-1.5 flex-wrap">
                  <Show when={saveFooterStatus() === "error"}>
                    <span class="settings-nav-badge settings-nav-badge-error">Error</span>
                  </Show>
                  <Show when={saveFooterStatus() === "dirty"}>
                    <span class="settings-nav-badge settings-nav-badge-dirty">Unsaved</span>
                  </Show>
                  <Show when={saveFooterStatus() === "saving"}>
                    <span class="settings-nav-badge settings-nav-badge-saving">Saving</span>
                  </Show>
                  <Show when={saveFooterStatus() === "saved"}>
                    <span class="settings-nav-badge settings-nav-badge-saved">Saved</span>
                  </Show>
                  <Show when={developerMode()}>
                    <span class="settings-nav-badge settings-nav-badge-dev">Dev</span>
                  </Show>
                </div>
              </div>
              <div class="ds-settings-search">
                <Icon name={getSemanticIcon("action.search")} size="small" />
                <input
                  value={search()}
                  placeholder="Search settings..."
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
                <div class="settings-empty-text px-3 py-6 text-text-weaker">No settings found</div>
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
                  <span>Developer mode</span>
                </button>
              </div>
              <Button type="button" variant="ghost" size="large" onClick={save.closeWithGuard}>
                Cancel
              </Button>
              <Show when={save.explicitDirty()}>
                <Button
                  type="button"
                  variant="primary"
                  size="large"
                  disabled={saving()}
                  onClick={() => void save.saveServerChanges({ close: true })}
                >
                  {saving() ? "Saving..." : "Save Changes"}
                </Button>
              </Show>
            </AppPanel.Footer>
          </AppPanel.Content>
        </AppPanel.Root>
      ) : (
        <div class="settings-panel-loading">Loading...</div>
      )}
      <div class="settings-popover-layer" ref={setSettingsPopoverLayer} />
    </div>
  )

  function renderActiveContent(): JSX.Element {
    const active = activeTab()
    switch (active) {
      case "account":
        return <AccountPanel />
      case "general":
        return (
          <GeneralPanel
            general={settings.general}
            onGeneralChange={(key, value) => setSettings("general", key, value)}
          />
        )
      case "models":
        return (
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
            onConnectProvider={() => setActiveTab("providers")}
          />
        )
      case "providers":
        return (
          <ProvidersPanel
            summaries={providerSummaries()}
            authMethods={globalSync.data.provider_auth}
            providerFocusID={providerFocusID()}
          />
        )
      case "github":
        return <GitHubPanel />
      case "usage":
        return (
          <UsagePanel
            onConnectProvider={(providerID) => {
              setProviderFocusID(providerID)
              setActiveTab("providers")
            }}
          />
        )
      case "learning":
        return (
          <LearningPanel
            library={settings.library}
            onLibraryChange={(key, value) => setSettings("library", key, value)}
          />
        )
      case "memory":
        return (
          <MemoryPanel
            library={settings.library}
            onLibraryChange={(key, value) => setSettings("library", key, value)}
          />
        )
      case "experience":
        return (
          <ExperiencePanel
            library={settings.library}
            onLibraryChange={(key, value) => setSettings("library", key, value)}
          />
        )
      case "mcp":
        return (
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
        )
      case "channels":
        return (
          <ChannelsPanel
            channels={settings.channels}
            providers={providerGroups()}
            onChannelToggle={(index, value) => setSettings("channels", "feishuAccounts", index, "enabled", value)}
            onChannelModelChange={(index, model) => setSettings("channels", "feishuAccounts", index, "model", model)}
          />
        )
      case "email":
        return (
          <EmailPanel
            email={settings.email}
            onEmailChange={(key, value) => setSettings("email", key, value as never)}
          />
        )
      case "permissions":
        return (
          <PermissionsPanel
            safety={settings.safety}
            onSafetyChange={(key, value) => setSettings("safety", key, value)}
          />
        )
      case "sandbox":
        return (
          <SandboxPanel
            safety={settings.safety}
            sandboxStatus={sandboxStatus()}
            onSafetyChange={(key, value) => setSettings("safety", key, value)}
          />
        )
      case "control-profile":
        return (
          <ControlProfilePanel
            safety={settings.safety}
            controlProfiles={controlProfiles() ?? []}
            onSafetyChange={(key, value) => setSettings("safety", key, value)}
          />
        )
      case "questions":
        return (
          <QuestionsPanel
            runtime={settings.runtime}
            onRuntimeChange={(key, value) => setSettings("runtime", key, value)}
          />
        )
      case "compaction":
        return (
          <CompactionPanel
            runtime={settings.runtime}
            onRuntimeChange={(key, value) => setSettings("runtime", key, value)}
          />
        )
      case "timeouts":
        return (
          <TimeoutsPanel
            runtime={settings.runtime}
            onRuntimeChange={(key, value) => setSettings("runtime", key, value)}
            availableAgents={(agents() ?? []).filter((a) => a.mode === "primary" && !a.hidden)}
            defaultAgent={settings.agents.defaultAgent}
            onDefaultAgentChange={(agent) => setSettings("agents", "defaultAgent", agent)}
          />
        )
      case "formatter":
        return referencePanel("Formatter", "Formatter configuration file access.", ["runtime"])
      case "lsp":
        return referencePanel("LSP", "Language server configuration file access.", ["runtime"])
      case "observability":
        return (
          <ObservabilityPanel
            runtime={settings.runtime}
            onRuntimeChange={(key, value) => setSettings("runtime", key, value)}
          />
        )
      case "import":
        return <ImportPanel domains={domainSummaries() ?? []} onImported={refreshAfterConfigChange} />
      case "config-files":
        return (
          <ConfigFilesPanel
            domains={domainSummaries() ?? []}
            openingDomain={openingDomain()}
            onOpenDomain={(domain) => void openDomain(domain)}
          />
        )
      default:
        return renderPluginSection(active)
    }
  }

  function referencePanel(title: string, description: string, domainIds: string[]) {
    return (
      <ConfigReferencePanel
        title={title}
        description={description}
        domains={domainsFor(domainIds)}
        openingDomain={openingDomain()}
        onOpenDomain={(domain) => void openDomain(domain)}
      />
    )
  }

  function renderPluginSection(active: string) {
    const section = pluginSections().find((item) => item.id === active)
    if (!section) {
      return (
        <SettingsPage title="Settings" description="Select a settings section.">
          <SettingsSection>
            <div class="ds-empty-state">No section selected</div>
          </SettingsSection>
        </SettingsPage>
      )
    }
    return <PluginSettingsContent section={section} />
  }
}

function normalizeInitialTab(id: string | undefined) {
  if (!id) return "general"
  return legacyInitialTabs[id] ?? id
}

function compareSections(a: RegisteredSettingsSection, b: RegisteredSettingsSection) {
  return (
    settingsGroupOrder(a.group) - settingsGroupOrder(b.group) ||
    (a.order ?? 0) - (b.order ?? 0) ||
    a.label.localeCompare(b.label)
  )
}

function normalizeSearch(value: string) {
  return value.trim().toLowerCase()
}

function sectionIcon(section: RegisteredSettingsSection): IconName {
  if (section.iconToken) return getSemanticIcon(section.iconToken)
  return (section.icon ?? getSemanticIcon("settings.general")) as IconName
}

type PluginSettingsComponentProps = {
  pluginId?: string
  values: Record<string, unknown>
  onChange: (values: Record<string, unknown>) => void | Promise<void>
}

function PluginSettingsContent(props: { section: RegisteredSettingsSection }) {
  const globalSDK = useGlobalSDK()
  const [comp, setComp] = createSignal<Component<PluginSettingsComponentProps> | null>(null)
  const [loading, setLoading] = createSignal(true)

  const section = () => props.section
  const isSandbox = () => section().sandbox && section().sandboxUrl && section().pluginId
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
    const result = await globalSDK.client.plugin.updateConfig({ pluginId, body: next })
    mutate(result.data ?? next)
  }

  onMount(() => {
    const s = section()
    if (s.component) {
      setComp(() => s.component! as Component<PluginSettingsComponentProps>)
      setLoading(false)
      return
    }
    if (s.sandbox) {
      setLoading(false)
      return
    }
    if (s.loader) {
      s.loader().then(
        (mod) => {
          setComp(() => mod.default as Component<PluginSettingsComponentProps>)
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
      <Show when={isSandbox()}>
        <ErrorBoundary
          fallback={(error) => (
            <div class="settings-availability-message flex items-center justify-center py-8 text-icon-critical-base">
              {error.message}
            </div>
          )}
        >
          <SandboxIframe src={section().sandboxUrl!} pluginId={section().pluginId!} panelId={section().id} />
        </ErrorBoundary>
      </Show>
      <Show when={!isSandbox()}>
        <Show when={!section().pluginId || values()}>
          <Show
            when={comp()}
            fallback={
              <Show
                when={section().formSchema}
                fallback={
                  <div class="settings-availability-message flex items-center justify-center py-8">
                    {section().label} is not available
                  </div>
                }
              >
                {(schema) => (
                  <SettingsPage title={section().label}>
                    <SettingsSection>
                      <DeclarativeSettingsForm
                        schema={schema()}
                        values={values() ?? {}}
                        onChange={(next) => updateValues(next)}
                      />
                    </SettingsSection>
                  </SettingsPage>
                )}
              </Show>
            }
          >
            {(c) => (
              <Dynamic
                component={c()}
                pluginId={section().pluginId}
                values={values() ?? {}}
                onChange={(next: Record<string, unknown>) => updateValues(next)}
              />
            )}
          </Show>
        </Show>
      </Show>
    </Show>
  )
}
