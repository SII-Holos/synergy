import { createEffect, createSignal } from "solid-js"
import { useLingui } from "@lingui/solid"
import type { ConfigDomainSummary } from "@ericsanchezok/synergy-sdk/client"
import { useGlobalSDK } from "@/context/global-sdk"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import type { ConfirmOptions } from "@/components/dialog/confirm-dialog"
import { discardSettingsConfirm } from "@/components/dialog/confirm-copy"
import { groupPatchByDomain } from "../domain-routing"
import { requestErrorMessage } from "@/utils/error"

const copy = {
  saveFailed: { id: "settings.save.explicit.failed", message: "Failed to save" },
  requestFailed: { id: "settings.save.request.failed", message: "The settings request failed." },
  saved: { id: "settings.save.success.title", message: "Saved {label}" },
  changed: { id: "settings.save.explicit.changed", message: "Changed: {fields}" },
}

export type ShowConfirmFn = (params: ConfirmOptions) => void
export type SaveStatus = "idle" | "saving" | "saved" | "error"

export type SaveContext<TDraft> = {
  serverPatch: () => Record<string, unknown>
  serverDraft: () => TDraft
  domainSummaries: () => ConfigDomainSummary[]
  hasAnyChanges: () => boolean
  editingLabel: () => string
  refreshAfterConfigChange: (changedFields: string[], submittedDraft: TDraft) => Promise<void>
  onPatchSaved?: (patch: Record<string, unknown>, submittedDraft: TDraft) => void | Promise<void>
  preparePatchSave?: (patch: Record<string, unknown>, submittedDraft: TDraft) => void | Promise<void>
  rejectPatchSave?: (patch: Record<string, unknown>, submittedDraft: TDraft) => void | Promise<void>
  discardChanges: () => void | Promise<void>
  closeDialog: () => void
  showConfirm: ShowConfirmFn
}

export function useSettingsSave<TDraft>(ctx: SaveContext<TDraft>) {
  const globalSDK = useGlobalSDK()
  const { _ } = useLingui()
  const [status, setStatus] = createSignal<SaveStatus>("idle")
  const [explicitDirty, setExplicitDirty] = createSignal(false)

  createEffect(() => {
    const dirty = Object.keys(ctx.serverPatch()).length > 0
    setExplicitDirty(dirty)
    if (dirty && status() === "saved") setStatus("idle")
  })

  async function saveServerPatch(patch: Record<string, unknown>): Promise<string[]> {
    const grouped = groupPatchByDomain(patch, ctx.domainSummaries())
    const responses = await Promise.all(
      [...grouped.entries()].map(([domain, config]) =>
        globalSDK.client.config.domain.update({
          domain,
          configDomainUpdateInput: { config: config as never },
        }),
      ),
    )
    // The server reports which top-level config fields actually changed;
    // the panel uses this to refresh only the affected data instead of
    // re-fetching every resource across every scope.
    return responses.flatMap((response) => response.data?.changedFields ?? [])
  }

  async function saveServerChanges() {
    const patch = ctx.serverPatch()
    if (Object.keys(patch).length === 0) return true
    const submittedDraft = ctx.serverDraft()

    setStatus("saving")
    let persisted = false
    try {
      await ctx.preparePatchSave?.(patch, submittedDraft)
      const changedFields = await saveServerPatch(patch)
      persisted = true
      await ctx.refreshAfterConfigChange(changedFields, submittedDraft)
      await ctx.onPatchSaved?.(patch, submittedDraft)
      setExplicitDirty(Object.keys(ctx.serverPatch()).length > 0)
      setStatus("saved")
      showToast({
        type: "success",
        title: _({ ...copy.saved, values: { label: ctx.editingLabel() } }),
        description: _({ ...copy.changed, values: { fields: Object.keys(patch).join(", ") } }),
      })
      return true
    } catch (error) {
      if (!persisted) await ctx.rejectPatchSave?.(patch, submittedDraft)
      setStatus("error")
      showToast({
        type: "error",
        title: _(copy.saveFailed),
        description: requestErrorMessage(error, _(copy.requestFailed)),
      })
      return false
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
    runDiscardGuard(async () => {
      await ctx.discardChanges()
      ctx.closeDialog()
    })
  }

  return {
    saveServerChanges,
    closeWithGuard,
    status,
    explicitDirty,
  }
}
