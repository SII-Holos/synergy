import { createEffect, createSignal, onCleanup } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { showToast } from "@ericsanchezok/synergy-ui/toast"

export type ShowConfirmFn = (params: {
  title: string
  description: string
  confirmLabel: string
  cancelLabel: string
  onConfirm: () => void | Promise<void>
}) => void

export type SaveStatus = "idle" | "saving" | "saved" | "error"

const FIELD_DOMAIN: Record<string, string> = {
  snapshot: "general",
  autoupdate: "general",
  model: "models",
  nano_model: "models",
  mini_model: "models",
  mid_model: "models",
  vision_model: "models",
  thinking_model: "models",
  long_context_model: "models",
  creative_model: "models",
  engram: "engram",
  mcp: "mcp",
  plugin: "plugins",
  permission: "permissions",
  controlProfile: "permissions",
  channel: "channels",
  email: "email",
  question: "runtime",
  compaction: "runtime",
}

export type SaveContext = {
  serverPatch: () => Record<string, unknown>
  hasAnyChanges: () => boolean
  editingLabel: () => string
  setSaving: (value: boolean) => void
  refreshAfterConfigChange: () => Promise<void>
  closeDialog: () => void
  showConfirm: ShowConfirmFn
}

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
  channel: "background",
  mcp: "explicit",
  plugin: "explicit",
  email: "explicit",
  identity: "explicit",
}

export function useSettingsSave(ctx: SaveContext) {
  const globalSDK = useGlobalSDK()
  const [autoStatus, setAutoStatus] = createSignal<SaveStatus>("idle")
  const [bgStatus, setBgStatus] = createSignal<SaveStatus>("idle")
  const [explicitDirty, setExplicitDirty] = createSignal(false)

  let autoDebounce: ReturnType<typeof setTimeout> | undefined
  let bgDebounce: ReturnType<typeof setTimeout> | undefined

  onCleanup(() => cancelDebounces())

  function isAutoOnly(patch: Record<string, unknown>): boolean {
    return Object.keys(patch).every((key) => FIELD_SAVE_STRATEGY[key] === "auto")
  }

  function hasBackground(patch: Record<string, unknown>): boolean {
    return Object.keys(patch).some((key) => FIELD_SAVE_STRATEGY[key] === "background")
  }

  function hasExplicit(patch: Record<string, unknown>): boolean {
    return Object.keys(patch).some((key) => FIELD_SAVE_STRATEGY[key] === "explicit")
  }

  async function saveServerPatch(patch: Record<string, unknown>) {
    const grouped = new Map<string, Record<string, unknown>>()
    for (const [key, value] of Object.entries(patch)) {
      const domain = FIELD_DOMAIN[key]
      if (!domain) throw new Error(`Settings field "${key}" is not mapped to a config domain`)
      const domainPatch = grouped.get(domain) ?? {}
      domainPatch[key] = value
      grouped.set(domain, domainPatch)
    }
    await Promise.all(
      [...grouped.entries()].map(([domain, config]) =>
        globalSDK.client.config.domain.update({
          domain: domain as any,
          configDomainUpdateInput: { config: config as any },
        }),
      ),
    )
  }

  async function doAutoSave(patch: Record<string, unknown>) {
    if (Object.keys(patch).length === 0) return
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

  async function doBgSave(patch: Record<string, unknown>) {
    if (Object.keys(patch).length === 0) return
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
    cancelDebounces()

    if (isAutoOnly(patch)) {
      autoDebounce = setTimeout(() => void doAutoSave(patch), 300)
    } else if (hasBackground(patch)) {
      bgDebounce = setTimeout(() => void doBgSave(patch), 500)
    }
  })

  async function saveServerChanges(options?: { close?: boolean }) {
    const patch = ctx.serverPatch()
    if (Object.keys(patch).length === 0) {
      if (options?.close) ctx.closeDialog()
      return
    }

    ctx.setSaving(true)
    try {
      await saveServerPatch(patch)
      await ctx.refreshAfterConfigChange()
      setExplicitDirty(false)
      showToast({
        type: "success",
        title: `Saved ${ctx.editingLabel()}`,
        description: `Changed: ${Object.keys(patch).join(", ")}`,
      })
      if (options?.close) ctx.closeDialog()
    } catch (error: any) {
      showToast({ type: "error", title: "Failed to save", description: error.message })
    } finally {
      ctx.setSaving(false)
    }
  }

  function runDiscardGuard(action: string, onConfirm: () => void | Promise<void>) {
    if (!ctx.hasAnyChanges()) {
      void onConfirm()
      return
    }

    ctx.showConfirm({
      title: "Discard unsaved changes?",
      description: `You have unsaved changes for Settings. Discard them and ${action}?`,
      confirmLabel: "Discard",
      cancelLabel: "Keep Editing",
      onConfirm,
    })
  }

  function closeWithGuard() {
    runDiscardGuard("close Settings", () => ctx.closeDialog())
  }

  return {
    saveServerChanges,
    runDiscardGuard,
    closeWithGuard,
    autoStatus,
    bgStatus,
    explicitDirty,
    cancelDebounces,
  }
}
