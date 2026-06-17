import { createEffect, createMemo, createResource, createSignal, Show } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useGlobalSDK } from "@/context/global-sdk"
import { useInput, type SendShortcut } from "@/context/input"
import { useGlobalSync } from "@/context/global-sync"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import type { Config, ConfigSetSummary } from "@ericsanchezok/synergy-sdk/client"
import { DialogConfirm } from "@/components/dialog/dialog-confirm"
import { DialogSelectModel } from "@/components/dialog/dialog-select-model"
import "./settings-dialog.css"
import type {
  ProviderModel,
  McpEntry,
  EmailSettings,
  ChannelSettings,
  RawValidationState,
  SettingsEditMode,
  DialogSettingsProps,
} from "./types"
import { groupByProvider, emptyMcp } from "./types"
import { ensureInit } from "./hooks/useSettingsForm"
import { buildPatch } from "./hooks/useConfigPatch"
import { useSettingsSave } from "./hooks/useSettingsSave"
import { SettingsNav } from "./components/SettingsNav"
import { GeneralPanel } from "./panels/GeneralPanel"
import { ModelsPanel } from "./panels/ModelsPanel"
import { McpPanel } from "./panels/McpPanel"
import { PluginsPanel } from "./panels/PluginsPanel"
import { AdvancedPanel } from "./panels/AdvancedPanel"
import { IdentityPanel } from "./panels/IdentityPanel"
import { ChannelsPanel } from "./panels/ChannelsPanel"
import { ConfigSetsPanel } from "./panels/ConfigSetsPanel"
import { EmailPanel } from "./panels/EmailPanel"
import { RawEditorPanel } from "./panels/RawEditorPanel"

export function SettingsDialog(props: DialogSettingsProps) {
  const dialog = useDialog()
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const input = useInput()

  const [activeTab, setActiveTab] = createSignal(props.initialTab ?? "general")
  const [selectedSetName, setSelectedSetName] = createSignal<string>()
  const [initialized, setInitialized] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const [refreshing, setRefreshing] = createSignal(false)
  const [creatingSet, setCreatingSet] = createSignal(false)
  const [createSetName, setCreateSetName] = createSignal("")
  const [editMode, setEditMode] = createSignal<SettingsEditMode>("form")
  const [rawText, setRawText] = createSignal("")
  const [rawLoadedForSet, setRawLoadedForSet] = createSignal<string>()
  const [validatingRaw, setValidatingRaw] = createSignal(false)
  const [rawValidation, setRawValidation] = createStore<RawValidationState>({
    valid: true,
    errors: [],
    warnings: [],
  })

  const activeSet = createMemo(() => globalSync.configSets.find((set) => set.active))
  const selectedSet = createMemo<ConfigSetSummary | undefined>(() => {
    const requested = selectedSetName()
    if (requested) return globalSync.configSets.find((set) => set.name === requested)
    return activeSet()
  })
  const selectedSetIsActive = createMemo(() => selectedSet()?.name === activeSet()?.name)

  const [config, { refetch: refetchConfig }] = createResource(
    () => ({ name: selectedSet()?.name, activeName: activeSet()?.name }),
    async (source) => {
      if (!source.name) throw new Error("No Config Set selected")
      if (source.name === source.activeName) {
        const res = await globalSDK.client.config.global()
        return res.data!
      }
      const res = await globalSDK.client.config.set.get({ name: source.name })
      return res.data!.config as Config
    },
  )

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

  const [rawConfig, { refetch: refetchRawConfig }] = createResource(
    () => selectedSet()?.name,
    async (name) => {
      if (!name) throw new Error("No Config Set selected")
      const response = await globalSDK.client.config.set.raw.get({ name })
      return response.data!
    },
  )

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
    holos_friend_reply_model: "" as string,
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
    compaction_auto: "" as string,
    compaction_overflow_threshold: "" as string,
    permission: "" as string,
    question_timeout: "" as string,
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
      setName: selectedSet()?.name,
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
    selectedSet()?.name
    doEnsureInit()
  })

  createEffect(() => {
    const active = activeSet()?.name
    const selected = selectedSet()?.name
    if (!active || !selected) return
    if (selected === active && initializedForSet !== active) {
      resetEditor()
    }
  })

  const cancelDebouncesRef = { current: () => {} }

  function resetEditor() {
    setInitialized(false)
    initializedForSet = undefined
    setRawLoadedForSet(undefined)
    setRawValidation({ valid: true, errors: [], warnings: [] })
  }

  async function refreshAfterConfigChange() {
    cancelDebouncesRef.current()
    setRefreshing(true)
    resetEditor()
    await globalSync.refreshAllConfigs()
    await Promise.all([refetchConfig(), refetchRawConfig()])
    setRefreshing(false)
    doEnsureInit()
  }

  const serverPatch = createMemo<Record<string, unknown>>(() => {
    if (!initialized() || !config() || !selectedSet()?.name) return {}
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
  const editingLabel = createMemo(() => selectedSet()?.name ?? activeSet()?.name ?? "default")

  const hasRawChanges = createMemo(() => {
    const rc = rawConfig()
    if (!rc) return false
    return rawLoadedForSet() === selectedSet()?.name && rawText() !== rc.raw
  })

  const hasAnyChanges = createMemo(() => {
    if (editMode() === "raw") return hasRawChanges()
    return hasServerChanges()
  })

  createEffect(() => {
    const rc = rawConfig()
    const setName = selectedSet()?.name
    if (!rc || !setName || rawLoadedForSet() === setName) return
    setRawText(rc.raw)
    setRawLoadedForSet(setName)
    setRawValidation({ valid: true, errors: [], warnings: [] })
  })

  async function validateRawConfig() {
    const setName = selectedSet()?.name
    if (!setName) return false
    setValidatingRaw(true)
    try {
      const response = await globalSDK.client.config.set.raw.validate({
        name: setName,
        configSetRawValidateInput: { raw: rawText() },
      })
      const data = response.data
      if (!data) {
        setRawValidation({ valid: false, errors: ["Validation returned no data"], warnings: [] })
        return false
      }
      setRawValidation({
        valid: data.valid,
        errors: data.errors ?? [],
        warnings: data.warnings ?? [],
      })
      return data.valid as boolean
    } catch (error: any) {
      setRawValidation({ valid: false, errors: [error.message], warnings: [] })
      return false
    } finally {
      setValidatingRaw(false)
    }
  }

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
    hasServerChanges,
    hasRawChanges,
    hasAnyChanges,
    selectedSet,
    activeSet,
    selectedSetIsActive,
    editingLabel,
    editMode,
    setEditMode,
    setSaving,
    setSelectedSetName,
    setActiveTab,
    resetEditor,
    refreshAfterConfigChange,
    rawText,
    setRawValidation,
    setValidatingRaw,
    validateRawConfig,
    closeDialog: () => dialog.close(),
    showConfirm,
  })
  cancelDebouncesRef.current = save.cancelDebounces

  function handleLocalSendShortcut(value: SendShortcut) {
    setGeneral("sendShortcut", value)
    if (value !== input.sendShortcut()) {
      input.setSendShortcut(value)
      showToast({ title: "Send shortcut updated", description: "This device preference is saved immediately." })
    }
  }

  return (
    <Dialog title="Settings" class="dialog-settings-v2">
      {ready() ? (
        <div class="ds-settings-layout">
          <div class="ds-settings-rail">
            <div class="ds-settings-rail-top">
              <Show when={editMode() === "form"}>
                <div class="ds-rail-set-info">
                  <div class="ds-rail-set-name">{selectedSet()?.name ?? activeSet()?.name ?? "default"}</div>
                  <Show when={!selectedSetIsActive()}>
                    <span class="ds-rail-set-inactive">Inactive</span>
                  </Show>
                  <Show when={save.explicitDirty()}>
                    <span class="ds-rail-set-dirty">Unsaved</span>
                  </Show>
                  <Show when={save.autoStatus() === "saved"}>
                    <span class="ds-rail-set-saved">Saved</span>
                  </Show>
                </div>
              </Show>
              <Show when={editMode() === "raw"}>
                <div class="ds-rail-set-info">
                  <div class="ds-rail-set-name">{editingLabel()}</div>
                  <span class="ds-rail-set-mode">Raw</span>
                  <Show when={hasRawChanges()}>
                    <span class="ds-rail-set-dirty">Unsaved</span>
                  </Show>
                </div>
              </Show>
              <SettingsNav activeTab={activeTab} onSelect={setActiveTab} />
            </div>
            <div class="ds-settings-rail-footer">
              <button
                type="button"
                class="ds-mode-toggle"
                classList={{ "ds-mode-toggle-active": editMode() === "raw" }}
                onClick={() => save.switchToEditMode(editMode() === "raw" ? "form" : "raw")}
              >
                <Icon name={editMode() === "raw" ? "settings" : "code"} size="small" />
                <span>{editMode() === "raw" ? "Form" : "JSON"}</span>
              </button>
            </div>
          </div>

          <div class="ds-settings-content">
            <Show when={editMode() === "form" && activeTab() === "general"}>
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

            <Show when={editMode() === "form" && activeTab() === "models"}>
              <ModelsPanel
                models={models}
                providerModels={providerModels}
                onModelChange={(key, value) => setModels(key, value)}
                onManageModels={() => dialog.show(() => <DialogSelectModel />)}
              />
            </Show>

            <Show when={editMode() === "form" && activeTab() === "mcp"}>
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

            <Show when={editMode() === "form" && activeTab() === "plugins"}>
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

            <Show when={editMode() === "form" && activeTab() === "channels"}>
              <ChannelsPanel
                channels={channels}
                onChannelToggle={(index, value) => setChannels("feishuAccounts", index, "enabled", value)}
              />
            </Show>

            <Show when={editMode() === "form" && activeTab() === "email"}>
              <EmailPanel email={email} onEmailChange={(key, value) => setEmail(key, value as never)} />
            </Show>

            <Show when={editMode() === "form" && activeTab() === "identity"}>
              <IdentityPanel identity={identity} onIdentityChange={(key, value) => setIdentity(key, value)} />
            </Show>

            <Show when={editMode() === "form" && activeTab() === "advanced"}>
              <AdvancedPanel advanced={advanced} onAdvancedChange={(key, value) => setAdvanced(key, value)} />
            </Show>

            <Show when={editMode() === "form" && activeTab() === "config-sets"}>
              <ConfigSetsPanel
                configSets={globalSync.configSets}
                selectedSetName={selectedSetName}
                activeSetName={() => activeSet()?.name}
                createSetName={createSetName}
                creatingSet={creatingSet}
                onOpenSet={(name) => {
                  if (name !== selectedSet()?.name && hasAnyChanges()) {
                    save.runDiscardGuard(`open ${name}`, async () => {
                      setSelectedSetName(name)
                      setActiveTab("general")
                      resetEditor()
                      const isActive = globalSync.configSets.find((s) => s.name === name)?.active
                      showToast({
                        title: `Opened ${name}`,
                        description: isActive
                          ? "You are now editing the active Config Set. Save changes to update runtime config."
                          : "You are now editing an inactive Config Set. Save changes here, then activate it when ready.",
                      })
                    })
                    return
                  }
                  setSelectedSetName(name)
                  setActiveTab("general")
                  resetEditor()
                  const isActive = globalSync.configSets.find((s) => s.name === name)?.active
                  showToast({
                    title: `Opened ${name}`,
                    description: isActive
                      ? "You are now editing the active Config Set. Save changes to update runtime config."
                      : "You are now editing an inactive Config Set. Save changes here, then activate it when ready.",
                  })
                }}
                onActivateSet={save.handleSwitchSet}
                onDeleteSet={save.handleDeleteSet}
                onCreateSetNameChange={setCreateSetName}
                onCreateSet={() => save.handleCreateSet(createSetName())}
              />
            </Show>

            <Show when={editMode() === "raw"}>
              <RawEditorPanel
                rawPath={rawConfig()?.path}
                rawText={rawText}
                rawValidation={rawValidation}
                validatingRaw={validatingRaw}
                hasRawChanges={hasRawChanges}
                onValidate={validateRawConfig}
                onTextChange={(value) => {
                  setRawText(value)
                  if (!rawValidation.valid || rawValidation.errors.length > 0) {
                    setRawValidation({ valid: true, errors: [], warnings: [] })
                  }
                }}
              />
            </Show>

            <div class="ds-footer">
              <div class="ds-footer-status">
                <Show when={save.bgStatus() === "saving"}>
                  <span class="ds-save-status ds-save-status-saving">Saving...</span>
                </Show>
                <Show when={save.bgStatus() === "saved"}>
                  <span class="ds-save-status ds-save-status-done">
                    <Icon name="check" size="small" />
                    Saved
                  </span>
                </Show>
                <Show when={save.autoStatus() === "error" || save.bgStatus() === "error"}>
                  <span class="ds-save-status ds-save-status-error">Save failed</span>
                </Show>
              </div>
              <Button type="button" variant="ghost" size="large" onClick={save.closeWithGuard}>
                Cancel
              </Button>
              <Show when={editMode() === "raw"}>
                <Show
                  when={!selectedSetIsActive()}
                  fallback={
                    <Button
                      type="button"
                      variant="primary"
                      size="large"
                      disabled={saving() || !hasRawChanges()}
                      onClick={() => void save.saveRawConfig({ close: true })}
                    >
                      {saving() ? "Saving..." : "Save Changes"}
                    </Button>
                  }
                >
                  <Button
                    type="button"
                    variant="secondary"
                    size="large"
                    disabled={saving() || !hasRawChanges()}
                    onClick={() => void save.saveRawConfig({ close: true })}
                  >
                    {saving() ? "Saving..." : `Save to ${editingLabel()}`}
                  </Button>
                  <Button
                    type="button"
                    variant="primary"
                    size="large"
                    disabled={saving()}
                    onClick={() => void save.saveRawConfig({ activate: true, close: true })}
                  >
                    {saving() ? "Saving..." : `Save & Activate ${editingLabel()}`}
                  </Button>
                </Show>
              </Show>
              <Show when={editMode() === "form" && save.explicitDirty()}>
                <Show
                  when={!selectedSetIsActive()}
                  fallback={
                    <Button
                      type="button"
                      variant="primary"
                      size="large"
                      disabled={saving()}
                      onClick={() => void save.saveServerChanges({ close: true })}
                    >
                      {saving() ? "Saving..." : "Save Changes"}
                    </Button>
                  }
                >
                  <Button
                    type="button"
                    variant="secondary"
                    size="large"
                    disabled={saving()}
                    onClick={() => void save.saveServerChanges({ close: true })}
                  >
                    {saving() ? "Saving..." : `Save to ${editingLabel()}`}
                  </Button>
                  <Button
                    type="button"
                    variant="primary"
                    size="large"
                    disabled={saving()}
                    onClick={() => void save.saveServerChanges({ activate: true, close: true })}
                  >
                    {saving() ? "Saving..." : `Save & Activate ${editingLabel()}`}
                  </Button>
                </Show>
              </Show>
            </div>
          </div>
        </div>
      ) : (
        <div class="flex items-center justify-center py-8 text-13-regular text-text-weak">Loading...</div>
      )}
    </Dialog>
  )
}
