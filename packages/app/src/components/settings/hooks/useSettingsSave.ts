import { createEffect, createSignal, onCleanup } from "solid-js"
import { useLingui } from "@lingui/solid"
import type { ConfigDomainSummary } from "@ericsanchezok/synergy-sdk/client"
import { useGlobalSDK } from "@/context/global-sdk"
import { getToastConfig, showToast } from "@ericsanchezok/synergy-ui/toast"
import type { ConfirmOptions } from "@/components/dialog/confirm-dialog"
import { discardSettingsConfirm } from "@/components/dialog/confirm-copy"
import { groupPatchByDomain, strategyForPatch } from "../domain-routing"
import { requestErrorMessage } from "@/utils/error"

const copy = {
  autoSaveFailed: { id: "settings.save.auto.failed", message: "Auto-save failed" },
  backgroundSaveFailed: { id: "settings.save.background.failed", message: "Background save failed" },
  saveFailed: { id: "settings.save.explicit.failed", message: "Failed to save" },
  requestFailed: { id: "settings.save.request.failed", message: "The settings request failed." },
  saved: { id: "settings.save.success.title", message: "Saved {label}" },
  updated: { id: "settings.save.background.updated", message: "Updated: {fields}" },
  changed: { id: "settings.save.explicit.changed", message: "Changed: {fields}" },
}

export type ShowConfirmFn = (params: ConfirmOptions) => void

export type SaveStatus = "idle" | "saving" | "saved" | "error"

export type SaveContext = {
  serverPatch: () => Record<string, unknown>
  domainSummaries: () => ConfigDomainSummary[]
  hasAnyChanges: () => boolean
  editingLabel: () => string
  setSaving: (value: boolean) => void
  refreshAfterConfigChange: () => Promise<void>
  closeDialog: () => void
  showConfirm: ShowConfirmFn
}

export function useSettingsSave(ctx: SaveContext) {
  const globalSDK = useGlobalSDK()
  const { _ } = useLingui()
  const [autoStatus, setAutoStatus] = createSignal<SaveStatus>("idle")
  const [bgStatus, setBgStatus] = createSignal<SaveStatus>("idle")
  const [explicitDirty, setExplicitDirty] = createSignal(false)

  let autoDebounce: ReturnType<typeof setTimeout> | undefined
  let bgDebounce: ReturnType<typeof setTimeout> | undefined
  let autoResetTimer: ReturnType<typeof setTimeout> | undefined
  let bgResetTimer: ReturnType<typeof setTimeout> | undefined
  let saveGen = 0

  onCleanup(() => cancelDebounces())

  function patchStrategies(patch: Record<string, unknown>) {
    return strategyForPatch(patch)
  }

  function isAutoOnly(patch: Record<string, unknown>): boolean {
    return patchStrategies(patch).every((strategy) => strategy === "auto")
  }

  function hasBackground(patch: Record<string, unknown>): boolean {
    return patchStrategies(patch).some((strategy) => strategy === "background")
  }

  function hasExplicit(patch: Record<string, unknown>): boolean {
    return patchStrategies(patch).some((strategy) => strategy === "explicit")
  }

  async function saveServerPatch(patch: Record<string, unknown>) {
    const grouped = groupPatchByDomain(patch, ctx.domainSummaries())
    await Promise.all(
      [...grouped.entries()].map(([domain, config]) =>
        globalSDK.client.config.domain.update({
          domain,
          configDomainUpdateInput: { config: config as any },
        }),
      ),
    )
  }

  async function doAutoSave(patch: Record<string, unknown>) {
    if (Object.keys(patch).length === 0) return
    const gen = ++saveGen
    setAutoStatus("saving")
    try {
      await saveServerPatch(patch)
      await ctx.refreshAfterConfigChange()
      if (saveGen !== gen) return
      setAutoStatus("saved")
      if (autoResetTimer) clearTimeout(autoResetTimer)
      autoResetTimer = setTimeout(() => {
        if (saveGen === gen) setAutoStatus("idle")
      }, 2000)
    } catch (error) {
      if (saveGen !== gen) return
      setAutoStatus("error")
      showToast({
        type: "error",
        title: _(copy.autoSaveFailed),
        description: requestErrorMessage(error, _(copy.requestFailed)),
      })
    }
  }

  async function doBgSave(patch: Record<string, unknown>) {
    if (Object.keys(patch).length === 0) return
    const gen = ++saveGen
    setBgStatus("saving")
    try {
      await saveServerPatch(patch)
      await ctx.refreshAfterConfigChange()
      if (saveGen !== gen) return
      setBgStatus("saved")
      if (bgResetTimer) clearTimeout(bgResetTimer)
      bgResetTimer = setTimeout(() => {
        if (saveGen === gen) setBgStatus("idle")
      }, 2000)
      if (!getToastConfig()?.muted?.includes("success")) {
        showToast({
          type: "success",
          title: _({ ...copy.saved, values: { label: ctx.editingLabel() } }),
          description: _({ ...copy.updated, values: { fields: Object.keys(patch).join(", ") } }),
        })
      }
    } catch (error) {
      if (saveGen !== gen) return
      setBgStatus("error")
      showToast({
        type: "error",
        title: _(copy.backgroundSaveFailed),
        description: requestErrorMessage(error, _(copy.requestFailed)),
      })
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

  async function saveServerChanges() {
    const patch = ctx.serverPatch()
    if (Object.keys(patch).length === 0) return true

    ctx.setSaving(true)
    try {
      await saveServerPatch(patch)
      await ctx.refreshAfterConfigChange()
      setExplicitDirty(false)
      showToast({
        type: "success",
        title: _({ ...copy.saved, values: { label: ctx.editingLabel() } }),
        description: _({ ...copy.changed, values: { fields: Object.keys(patch).join(", ") } }),
      })
      return true
    } catch (error) {
      showToast({
        type: "error",
        title: _(copy.saveFailed),
        description: requestErrorMessage(error, _(copy.requestFailed)),
      })
      return false
    } finally {
      ctx.setSaving(false)
    }
  }

  function runDiscardGuard(onConfirm: () => void | Promise<void>) {
    if (!ctx.hasAnyChanges()) {
      void onConfirm()
      return
    }

    ctx.showConfirm({
      ...discardSettingsConfirm(),
      onConfirm,
    })
  }

  function closeWithGuard() {
    runDiscardGuard(() => ctx.closeDialog())
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
