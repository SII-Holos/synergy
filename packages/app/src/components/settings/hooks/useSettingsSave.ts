import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import type { Config } from "@ericsanchezok/synergy-sdk/client"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import type { RawValidationState, SettingsEditMode } from "../types"

export type ShowConfirmFn = (params: {
  title: string
  description: string
  confirmLabel: string
  cancelLabel: string
  onConfirm: () => void | Promise<void>
}) => void

export type SaveStatus = "idle" | "saving" | "saved" | "error"

export type SaveContext = {
  serverPatch: () => Record<string, unknown>
  hasServerChanges: () => boolean
  hasRawChanges: () => boolean
  hasAnyChanges: () => boolean
  selectedSet: () => { name?: string } | undefined
  activeSet: () => { name?: string } | undefined
  selectedSetIsActive: () => boolean
  editingLabel: () => string
  editMode: () => SettingsEditMode
  setEditMode: (mode: SettingsEditMode) => void
  setSaving: (value: boolean) => void
  setSelectedSetName: (name: string | undefined) => void
  setActiveTab: (id: string) => void
  resetEditor: () => void
  refreshAfterConfigChange: () => Promise<void>
  rawText: () => string
  setRawValidation: (values: Partial<RawValidationState>) => void
  setValidatingRaw: (value: boolean) => void
  validateRawConfig: () => Promise<boolean>
  closeDialog: () => void
  showConfirm: ShowConfirmFn
}

/**
 * Field-level save strategy classification.
 * - auto: Save immediately on change (300ms debounce), no UI indicator needed.
 * - background: Save in background (500ms debounce), subtle "Saving..." indicator.
 * - explicit: Requires user to click Save. Shows "Unsaved changes" badge.
 */
export const FIELD_SAVE_STRATEGY: Record<string, "auto" | "background" | "explicit"> = {
  snapshot: "auto",
  autoupdate: "auto",
  compaction: "auto",
  question: "background",
  permission: "background",
  controlProfile: "explicit",
  model: "background",
  nano_model: "background",
  mini_model: "background",
  mid_model: "background",
  vision_model: "background",
  thinking_model: "background",
  long_context_model: "background",
  creative_model: "background",
  holos_friend_reply_model: "background",
  channel: "background",
  mcp: "explicit",
  plugin: "explicit",
  email: "explicit",
  identity: "explicit",
}

export function useSettingsSave(ctx: SaveContext) {
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const [autoStatus, setAutoStatus] = createSignal<SaveStatus>("idle")
  const [bgStatus, setBgStatus] = createSignal<SaveStatus>("idle")
  const [explicitDirty, setExplicitDirty] = createSignal(false)

  let autoDebounce: ReturnType<typeof setTimeout> | undefined
  let bgDebounce: ReturnType<typeof setTimeout> | undefined

  onCleanup(() => {
    if (autoDebounce) clearTimeout(autoDebounce)
    if (bgDebounce) clearTimeout(bgDebounce)
  })

  /** Returns true if the patch contains only auto-save fields */
  function isAutoOnly(patch: Record<string, unknown>): boolean {
    return Object.keys(patch).every((k) => FIELD_SAVE_STRATEGY[k] === "auto")
  }

  /** Returns true if the patch contains background-save fields (excluding auto-only) */
  function hasBackground(patch: Record<string, unknown>): boolean {
    return Object.keys(patch).some((k) => FIELD_SAVE_STRATEGY[k] === "background")
  }

  /** Returns true if the patch contains explicit-save fields */
  function hasExplicit(patch: Record<string, unknown>): boolean {
    return Object.keys(patch).some((k) => FIELD_SAVE_STRATEGY[k] === "explicit")
  }

  async function saveServerPatch(patch: Record<string, unknown>) {
    const setName = ctx.selectedSet()?.name
    if (!setName) return

    if (ctx.selectedSetIsActive()) {
      await globalSDK.client.config.update({ config: patch as any })
      return
    }

    await globalSDK.client.config.set.update({ name: setName, config: patch as Config })
  }

  /** Auto-save: dispatched on change for auto + background fields */
  async function doAutoSave(patch: Record<string, unknown>) {
    const currentPatch = ctx.serverPatch()
    if (!currentPatch || Object.keys(currentPatch).length === 0) return
    setAutoStatus("saving")
    try {
      await saveServerPatch(patch)
      setAutoStatus("saved")
      await ctx.refreshAfterConfigChange()
      setTimeout(() => setAutoStatus("idle"), 2000)
    } catch (error: any) {
      setAutoStatus("error")
      showToast({ type: "error", title: "Auto-save failed", description: error.message })
    }
  }

  /** Background save (debounced) */
  async function doBgSave(patch: Record<string, unknown>) {
    const currentPatch = ctx.serverPatch()
    if (!currentPatch || Object.keys(currentPatch).length === 0) return
    setBgStatus("saving")
    try {
      await saveServerPatch(patch)
      setBgStatus("saved")
      await ctx.refreshAfterConfigChange()
      showToast({
        type: "success",
        title: `Saved ${ctx.editingLabel()}`,
        description: `Updated: ${Object.keys(patch).join(", ")}`,
      })
      setTimeout(() => setBgStatus("idle"), 2000)
    } catch (error: any) {
      setBgStatus("error")
      showToast({ type: "error", title: "Background save failed", description: error.message })
    }
  }

  function cancelDebounces() {
    if (autoDebounce) {
      clearTimeout(autoDebounce)
      autoDebounce = undefined
    }
    if (bgDebounce) {
      clearTimeout(bgDebounce)
      bgDebounce = undefined
    }
  }

  // Watch patch and trigger auto/background saves
  createEffect(() => {
    const patch = ctx.serverPatch()
    if (Object.keys(patch).length === 0) {
      setExplicitDirty(false)
      return
    }

    if (hasExplicit(patch)) {
      setExplicitDirty(true)
      return
    }

    setExplicitDirty(false)

    // Clear previous debounces
    cancelDebounces()

    if (isAutoOnly(patch)) {
      autoDebounce = setTimeout(() => {
        void doAutoSave(patch)
      }, 300)
    } else if (hasBackground(patch)) {
      bgDebounce = setTimeout(() => {
        void doBgSave(patch)
      }, 500)
    }
  })

  async function saveServerChanges(options?: { activate?: boolean; close?: boolean }) {
    const patch = ctx.serverPatch()
    const shouldActivate = options?.activate === true && !ctx.selectedSetIsActive()

    if (Object.keys(patch).length === 0 && !shouldActivate) {
      if (options?.close) ctx.closeDialog()
      return
    }

    ctx.setSaving(true)
    try {
      const changed: string[] = []

      if (Object.keys(patch).length > 0) {
        await saveServerPatch(patch)
        changed.push(...Object.keys(patch))
      }

      if (shouldActivate) {
        await globalSDK.client.config.set.activate({ name: ctx.editingLabel() })
        changed.push("active config set")
      }

      if (Object.keys(patch).length > 0 || shouldActivate) {
        await ctx.refreshAfterConfigChange()
      }

      setExplicitDirty(false)

      if (changed.length > 0) {
        showToast({
          type: "success",
          title: shouldActivate ? `Saved and activated ${ctx.editingLabel()}` : `Saved ${ctx.editingLabel()}`,
          description: `Changed: ${changed.join(", ")}`,
        })
      }

      if (options?.close) ctx.closeDialog()
    } catch (error: any) {
      showToast({ type: "error", title: "Failed to save", description: error.message })
    } finally {
      ctx.setSaving(false)
    }
  }

  async function saveRawConfig(options?: { activate?: boolean; close?: boolean }) {
    const setName = ctx.selectedSet()?.name
    if (!setName) return

    const valid = await ctx.validateRawConfig()
    if (!valid) {
      showToast({ type: "warning", title: "Validation failed", description: "Fix the errors before saving." })
      return
    }

    ctx.setSaving(true)
    try {
      const shouldActivate = options?.activate === true && !ctx.selectedSetIsActive()
      const response = await globalSDK.client.config.set.raw.save({
        name: setName,
        configSetRawSaveInput: { raw: ctx.rawText(), reload: true },
      })
      const data = response.data
      if (!data) {
        throw new Error("Save returned no data")
      }

      if (shouldActivate) {
        await globalSDK.client.config.set.activate({ name: setName })
      }

      await ctx.refreshAfterConfigChange()
      showToast({
        type: "success",
        title: shouldActivate ? `Saved and activated ${setName}` : `Saved ${setName}`,
        description: "Raw config saved and validated.",
      })

      if (options?.close) ctx.closeDialog()
    } catch (error: any) {
      showToast({ type: "error", title: "Failed to save", description: error.message })
    } finally {
      ctx.setSaving(false)
    }
  }

  function switchToEditMode(mode: SettingsEditMode) {
    if (mode === ctx.editMode()) return
    const guard = mode === "raw" ? ctx.hasServerChanges() : ctx.hasRawChanges()
    if (guard) {
      const fromLabel = ctx.editMode() === "raw" ? "raw editor" : "form"
      const toLabel = mode === "raw" ? "raw editor" : "form"
      ctx.showConfirm({
        title: "Discard unsaved changes?",
        description: `Switching from ${fromLabel} to ${toLabel} will discard your unsaved changes.`,
        confirmLabel: "Discard",
        cancelLabel: "Keep Editing",
        onConfirm: () => {
          if (mode === "raw") {
            ctx.resetEditor()
          }
          ctx.setEditMode(mode)
        },
      })
      return
    }
    ctx.setEditMode(mode)
  }

  function runDiscardGuard(action: string, onConfirm: () => void | Promise<void>) {
    if (!ctx.hasAnyChanges()) {
      void onConfirm()
      return
    }

    ctx.showConfirm({
      title: "Discard unsaved changes?",
      description: `You have unsaved changes for ${ctx.editingLabel()}. Discard them and ${action}?`,
      confirmLabel: "Discard",
      cancelLabel: "Keep Editing",
      onConfirm,
    })
  }

  function closeWithGuard() {
    runDiscardGuard("close Settings", () => ctx.closeDialog())
  }

  async function handleSwitchSet(name: string) {
    if (name === ctx.activeSet()?.name) {
      ctx.setSelectedSetName(name)
      return
    }

    if (ctx.hasAnyChanges()) {
      runDiscardGuard(`activate ${name}`, async () => {
        ctx.setSaving(true)
        try {
          ctx.setSelectedSetName(name)
          ctx.resetEditor()
          await globalSDK.client.config.set.activate({ name })
          await ctx.refreshAfterConfigChange()
          showToast({ type: "info", title: "Config Set activated", description: `Using ${name}` })
        } catch (error: any) {
          showToast({ type: "error", title: "Failed to switch Config Set", description: error.message })
        } finally {
          ctx.setSaving(false)
        }
      })
      return
    }

    ctx.setSaving(true)
    try {
      ctx.setSelectedSetName(name)
      ctx.resetEditor()
      await globalSDK.client.config.set.activate({ name })
      await ctx.refreshAfterConfigChange()
      showToast({ type: "info", title: "Config Set activated", description: `Using ${name}` })
    } catch (error: any) {
      showToast({ type: "error", title: "Failed to switch Config Set", description: error.message })
    } finally {
      ctx.setSaving(false)
    }
  }

  async function handleCreateSet(createSetName: string) {
    const name = createSetName.trim()
    if (!name) {
      showToast({ type: "warning", title: "Config Set name required" })
      return
    }

    ctx.setSaving(true)
    try {
      await globalSDK.client.config.set.create({ configSetCreateInput: { name } })
      await globalSync.loadConfigSets()
      ctx.setSelectedSetName(name)
      ctx.setActiveTab("general")
      ctx.resetEditor()
      showToast({
        type: "info",
        title: `Now editing ${name}`,
        description: `${name} starts as a copy of ${ctx.activeSet()?.name ?? "the active set"}. Review the tabs and save any changes you want to keep.`,
      })
    } catch (error: any) {
      showToast({ type: "error", title: "Failed to create Config Set", description: error.message })
    } finally {
      ctx.setSaving(false)
    }
  }

  async function handleDeleteSet(name: string) {
    if (name === ctx.activeSet()?.name) {
      showToast({ type: "warning", title: "Cannot delete active Config Set" })
      return
    }

    ctx.setSaving(true)
    try {
      await globalSDK.client.config.set.delete({ name })
      await globalSync.loadConfigSets()
      if (ctx.selectedSet()?.name === name) ctx.setSelectedSetName(ctx.activeSet()?.name)
      showToast({ type: "info", title: "Config Set deleted", description: name })
    } catch (error: any) {
      showToast({ type: "error", title: "Failed to delete Config Set", description: error.message })
    } finally {
      ctx.setSaving(false)
    }
  }

  return {
    saveServerChanges,
    saveRawConfig,
    switchToEditMode,
    runDiscardGuard,
    closeWithGuard,
    handleSwitchSet,
    handleCreateSet,
    handleDeleteSet,
    autoStatus,
    bgStatus,
    explicitDirty,
    cancelDebounces,
  }
}
