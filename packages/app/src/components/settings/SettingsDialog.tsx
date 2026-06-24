import { ErrorBoundary, createEffect, createMemo, createResource, createSignal, Show, For, onMount } from "solid-js"
import type { Component } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { Dynamic } from "solid-js/web"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon, type IconName } from "@ericsanchezok/synergy-ui/icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useGlobalSDK } from "@/context/global-sdk"
import { useInput, type SendShortcut } from "@/context/input"
import { useGlobalSync } from "@/context/global-sync"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import type { ControlProfileSummary, SandboxStatus } from "@ericsanchezok/synergy-sdk/client"
import { DialogConfirm } from "@/components/dialog/dialog-confirm"
import { DialogSelectModel } from "@/components/dialog/dialog-select-model"
import { getSettingsSections, type SettingsSection } from "@/plugin"
import { SandboxIframe } from "@/plugin/sandbox"
import { AppPanel } from "@/components/app-panel"
import "./settings-dialog.css"
import type { ProviderModel, McpEntry, EmailSettings, ChannelSettings, DialogSettingsProps } from "./types"
import { groupByProvider, emptyMcp } from "./types"
import { ensureInit } from "./hooks/useSettingsForm"
import { buildPatch } from "./hooks/useConfigPatch"
import { useSettingsSave } from "./hooks/useSettingsSave"
import { GeneralPanel } from "./panels/GeneralPanel"
import { ModelsPanel } from "./panels/ModelsPanel"
import { McpPanel } from "./panels/McpPanel"
import { PluginsPanel } from "./panels/PluginsPanel"
import { AdvancedPanel } from "./panels/AdvancedPanel"
import { IdentityPanel } from "./panels/IdentityPanel"
import { ChannelsPanel } from "./panels/ChannelsPanel"
import { EmailPanel } from "./panels/EmailPanel"
import { ImportPanel } from "./panels/ImportPanel"

export function SettingsDialog(props: DialogSettingsProps) {
  const dialog = useDialog()
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const input = useInput()

  const [activeTab, setActiveTab] = createSignal(props.initialTab ?? "general")
  const [initialized, setInitialized] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const [refreshing, setRefreshing] = createSignal(false)

  const [config, { refetch: refetchConfig }] = createResource(async () => {
    const res = await globalSDK.client.config.global()
    return res.data!
  })

  const providerModels = createMemo(() => {
    const data = globalSync.data.provider
    const list: ProviderModel[] = []
    for (const provider of data.all) {
      if (!data.connected.includes(provider.id)) continue
      for (const [modelId, model] of Object.entries(provider.models)) {
        list.push({
          providerId: provider.id,
          providerName: provider.name,
          modelId,
          modelName: model.name,
        })
      }
    }
    return list
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

  const [general, setGeneral] = createStore({
    snapshot: true,
    autoupdate: "" as string,
    sendShortcut: "enter" as SendShortcut,
  })

  const [models, setModels] = createStore({
    model: "" as string,
    nano_model: "" as string,
    mini_model: "" as string,
    mid_model: "" as string,
    vision_model: "" as string,
    thinking_model: "" as string,
    long_context_model: "" as string,
    creative_model: "" as string,
  })

  const [plugins, setPlugins] = createStore({
    entries: [] as { value: string }[],
  })

  const [mcps, setMcps] = createStore({
    entries: [] as McpEntry[],
  })

  const [identity, setIdentity] = createStore({
    evolution: "" as string,
    autonomy: "" as string,
    memorySimThreshold: "" as string,
    memoryTopK: "" as string,
    experienceSimThreshold: "" as string,
    experienceTopK: "" as string,
    experienceEpsilon: "" as string,
  })

  const [advanced, setAdvanced] = createStore({
    controlProfile: "guarded" as string,
    compaction_auto: "" as string,
    compaction_overflow_threshold: "" as string,
    permission: "" as string,
    question_timeout: "" as string,
    auto_classifier: "false" as string,
  })

  const [email, setEmail] = createStore<EmailSettings>({
    enabled: true,
    fromAddress: "",
    fromName: "",
    smtpHost: "",
    smtpPort: "",
    smtpSecure: true,
    smtpUsername: "",
    smtpPassword: "",
    imapHost: "",
    imapPort: "",
    imapSecure: true,
    imapUsername: "",
    imapPassword: "",
  })

  const [channels, setChannels] = createStore<ChannelSettings>({
    feishuAccounts: [],
  })

  const doEnsureInit = () => {
    const result = ensureInit({
      cfg: config(),
      setName: "global",
      refreshing,
      initialized,
      initializedForSet,
      sendShortcut: () => input.sendShortcut(),
      setGeneral: (v) => setGeneral(v),
      setModels: (v) => setModels(v),
      setPlugins: (v) => setPlugins(v),
      setMcps: (v) => setMcps(v),
      setAdvanced: (v) => setAdvanced(v),
      setEmail: (v) => setEmail(v),
      setChannels: (v) => setChannels(v),
      setIdentity: (v) => setIdentity(v),
      setInitialized,
      originalMcpsRef,
    })
    if (result !== undefined) {
      initializedForSet = result
    }
  }

  const ready = () => initialized()

  createEffect(() => {
    config()
    doEnsureInit()
  })

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
    await refetchConfig()
    setRefreshing(false)
    doEnsureInit()
  }

  const serverPatch = createMemo<Record<string, unknown>>(() => {
    if (!initialized() || !config()) return {}
    return buildPatch({
      cfg: config()!,
      general,
      models,
      plugins,
      mcps,
      advanced,
      email,
      channels,
      identity,
      originalMcps: originalMcpsRef.current,
    })
  })
  const hasServerChanges = createMemo(() => Object.keys(serverPatch()).length > 0)
  const editingLabel = createMemo(() => "Global Config")
  const hasAnyChanges = createMemo(() => hasServerChanges())

  function showConfirm(params: {
    title: string
    description: string
    confirmLabel: string
    cancelLabel: string
    onConfirm: () => void | Promise<void>
  }) {
    dialog.show(() => (
      <DialogConfirm
        title={params.title}
        description={params.description}
        confirmLabel={params.confirmLabel}
        cancelLabel={params.cancelLabel}
        confirmVariant="secondary"
        onConfirm={params.onConfirm}
      />
    ))
  }

  const save = useSettingsSave({
    serverPatch,
    hasAnyChanges,
    editingLabel,
    setSaving,
    refreshAfterConfigChange,
    closeDialog: () => dialog.close(),
    showConfirm,
  })
  cancelDebouncesRef.current = save.cancelDebounces

  function handleLocalSendShortcut(value: SendShortcut) {
    setGeneral("sendShortcut", value)
    if (value !== input.sendShortcut()) {
      input.setSendShortcut(value)
      showToast({
        type: "info",
        title: "Send shortcut updated",
        description: "This device preference is saved immediately.",
      })
    }
  }

  // Build nav groups from the settings registry, ordered by first-seen group.
  const settingsSections = createMemo(() => getSettingsSections())
  const navGroups = createMemo(() => {
    const sections = settingsSections()
    const order: string[] = []
    const map = new Map<string, SettingsSection[]>()
    for (const section of sections) {
      if (!map.has(section.group)) {
        map.set(section.group, [])
        order.push(section.group)
      }
      map.get(section.group)!.push(section)
    }
    return order.map((label) => ({
      label,
      sections: map.get(label)!,
    }))
  })

  // Sections that are NOT built-in — rendered via Dynamic component when they have a component
  const BUILTIN_IDS = new Set([
    "general",
    "models",
    "mcp",
    "plugins",
    "channels",
    "email",
    "import",
    "identity",
    "advanced",
  ])
  const pluginSections = createMemo(() => settingsSections().filter((s) => !BUILTIN_IDS.has(s.id)))

  return (
    <Dialog class="dialog-settings-v2">
      {ready() ? (
        <AppPanel.Root class="h-full min-h-0">
          <AppPanel.Nav>
            <div class="px-3 pt-4 pb-2 flex flex-col gap-0.5">
              <div class="text-14-medium text-text-strong truncate">Global Config</div>
              <div class="flex items-center gap-1.5 flex-wrap">
                <Show when={save.explicitDirty()}>
                  <span class="px-1.5 py-px rounded-full text-12-medium text-text-strong bg-icon-warning-base/18">
                    Unsaved
                  </span>
                </Show>
                <Show when={save.autoStatus() === "saved"}>
                  <span class="px-1.5 py-px rounded-full text-12-regular text-text-weak bg-icon-success-base/14">
                    Saved
                  </span>
                </Show>
              </div>
            </div>

            {/* Navigation groups — driven by settings registry */}
            <div class="flex-1 overflow-y-auto px-2 pb-3">
              <For each={navGroups()}>
                {(group) => (
                  <AppPanel.NavSection label={group.label}>
                    <For each={group.sections}>
                      {(section) => (
                        <AppPanel.NavItem
                          icon={section.icon as IconName}
                          label={section.label}
                          active={activeTab() === section.id}
                          onClick={() => setActiveTab(section.id)}
                        />
                      )}
                    </For>
                  </AppPanel.NavSection>
                )}
              </For>
            </div>
          </AppPanel.Nav>

          <AppPanel.Content>
            <AppPanel.Body padding={false}>
              <Show when={activeTab() === "general"}>
                <GeneralPanel
                  editingLabel={editingLabel()}
                  snapshot={general.snapshot}
                  autoupdate={general.autoupdate}
                  sendShortcut={general.sendShortcut}
                  onSnapshotChange={(value) => setGeneral("snapshot", value)}
                  onAutoupdateChange={(value) => setGeneral("autoupdate", value)}
                  onSendShortcutChange={handleLocalSendShortcut}
                />
              </Show>

              <Show when={activeTab() === "models"}>
                <ModelsPanel
                  models={models}
                  providerModels={providerModels}
                  onModelChange={(key, value) => setModels(key, value)}
                  onManageModels={() => dialog.show(() => <DialogSelectModel />)}
                />
              </Show>

              <Show when={activeTab() === "mcp"}>
                <McpPanel
                  entries={mcps.entries}
                  onAdd={() => setMcps("entries", (prev) => [...prev, emptyMcp()])}
                  onChange={(index, field, value) => setMcps("entries", index, field as keyof McpEntry, value as never)}
                  onRemove={(index) =>
                    setMcps(
                      "entries",
                      produce((draft) => {
                        draft.splice(index, 1)
                      }),
                    )
                  }
                />
              </Show>

              <Show when={activeTab() === "plugins"}>
                <PluginsPanel
                  entries={plugins.entries}
                  onAdd={() => setPlugins("entries", (prev) => [...prev, { value: "" }])}
                  onChange={(index, value) => setPlugins("entries", index, "value", value)}
                  onRemove={(index) =>
                    setPlugins(
                      "entries",
                      produce((draft) => {
                        draft.splice(index, 1)
                      }),
                    )
                  }
                />
              </Show>

              <Show when={activeTab() === "channels"}>
                <ChannelsPanel
                  channels={channels}
                  onChannelToggle={(index, value) => setChannels("feishuAccounts", index, "enabled", value)}
                />
              </Show>

              <Show when={activeTab() === "email"}>
                <EmailPanel email={email} onEmailChange={(key, value) => setEmail(key, value as never)} />
              </Show>

              <Show when={activeTab() === "import"}>
                <ImportPanel onImported={refreshAfterConfigChange} />
              </Show>

              <Show when={activeTab() === "identity"}>
                <IdentityPanel identity={identity} onIdentityChange={(key, value) => setIdentity(key, value)} />
              </Show>

              <Show when={activeTab() === "advanced"}>
                <AdvancedPanel
                  advanced={advanced}
                  controlProfiles={controlProfiles() ?? []}
                  sandboxStatus={sandboxStatus()}
                  onAdvancedChange={(key, value) => setAdvanced(key, value)}
                />
              </Show>

              <For each={pluginSections()}>
                {(section) => (
                  <Show when={activeTab() === section.id}>
                    <PluginSettingsContent section={section} />
                  </Show>
                )}
              </For>
            </AppPanel.Body>

            <AppPanel.Footer>
              <div class="flex-1 flex items-center gap-2">
                <Show when={save.bgStatus() === "saving"}>
                  <span class="text-12-medium text-text-interactive-base">Saving...</span>
                </Show>
                <Show when={save.bgStatus() === "saved"}>
                  <span class="flex items-center gap-1 text-12-medium text-text-weak">
                    <Icon name="check" size="small" />
                    Saved
                  </span>
                </Show>
                <Show when={save.autoStatus() === "error" || save.bgStatus() === "error"}>
                  <span class="text-12-medium text-icon-critical-base">Save failed</span>
                </Show>
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
        <div class="flex items-center justify-center py-8 text-13-regular text-text-weak">Loading...</div>
      )}
    </Dialog>
  )
}

/** Wrapper that shows a spinner while lazy-loading a plugin settings section component. */
function PluginSettingsContent(props: { section: SettingsSection }) {
  const [comp, setComp] = createSignal<Component | null>(null)
  const [loading, setLoading] = createSignal(true)

  const section = () => props.section
  const isSandbox = () => section().sandbox && section().sandboxUrl && section().pluginId

  onMount(() => {
    const s = section()
    if (s.component) {
      setComp(() => s.component!)
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
          setComp(() => mod.default)
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
            <div class="flex items-center justify-center py-8 text-13-regular text-icon-critical-base">
              {error.message}
            </div>
          )}
        >
          <SandboxIframe src={section().sandboxUrl!} pluginId={section().pluginId!} panelId={section().id} />
        </ErrorBoundary>
      </Show>
      <Show when={!isSandbox()}>
        <Show
          when={comp()}
          fallback={
            <div class="flex items-center justify-center py-8 text-13-regular text-text-weak">
              {section().label} is not available
            </div>
          }
        >
          {(c) => <Dynamic component={c()} />}
        </Show>
      </Show>
    </Show>
  )
}
