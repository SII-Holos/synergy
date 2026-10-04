import { createEffect, createSignal } from "solid-js"
import type { ConfigDomainSummary } from "@ericsanchezok/synergy-sdk/client"
import { useGlobalSDK } from "@/context/global-sdk"
import type { ConfirmOptions } from "@/components/dialog/confirm-dialog"
import { discardSettingsConfirm } from "@/components/dialog/confirm-copy"
import { groupPatchByDomain } from "../domain-routing"
import type { SettingsSaveOutcome } from "../settings-explicit-save"
import { createSettingsDomainSave } from "../settings-domain-save"

export type ShowConfirmFn = (params: ConfirmOptions) => void
export type SaveStatus = "idle" | "saving" | "saved" | "error" | "partial" | "refresh"

export type SaveContext<TDraft> = {
  serverPatch: () => Record<string, unknown>
  serverDraft: () => TDraft
  domainSummaries: () => ConfigDomainSummary[]
  hasAnyChanges: () => boolean
  editingLabel: () => string
  refreshAfterConfigChange: (
    changedFields: string[],
    submittedDraft: TDraft,
    savedConfig?: Record<string, unknown>,
  ) => Promise<void>
  onPatchSaved?: (patch: Record<string, unknown>, submittedDraft: TDraft) => void | Promise<void>
  preparePatchSave?: (patch: Record<string, unknown>, submittedDraft: TDraft) => void | Promise<void>
  rejectPatchSave?: (patch: Record<string, unknown>, submittedDraft: TDraft) => void | Promise<void>
  discardChanges: () => void | Promise<void>
  closeBlocked?: () => boolean
  closeDialog: () => void
  showConfirm: ShowConfirmFn
}

export function useSettingsSave<TDraft>(ctx: SaveContext<TDraft>) {
  const globalSDK = useGlobalSDK()
  const [status, setStatus] = createSignal<SaveStatus>("idle")
  const [refreshPending, setRefreshPending] = createSignal(false)
  const [explicitDirty, setExplicitDirty] = createSignal(false)
  const [failedDomains, setFailedDomains] = createSignal<ConfigDomainSummary[]>([])

  createEffect(() => {
    const dirty = Object.keys(ctx.serverPatch()).length > 0
    setExplicitDirty(dirty)
    if (dirty && status() === "saved") setStatus("idle")
  })

  let submittedDraft: TDraft
  const domains = createSettingsDomainSave(
    async (domain, config) => {
      const response = await globalSDK.client.config.domain.update(
        { domain: domain as ConfigDomainSummary["id"], configDomainUpdateInput: { config: config as never } },
        { throwOnError: true },
      )
      return {
        config: response.data?.config ?? config,
        changedFields: response.data?.changedFields ?? Object.keys(config),
      }
    },
    (receipt) => ctx.refreshAfterConfigChange(receipt.changedFields, submittedDraft, receipt.config),
  )

  function domainOutcome(): SettingsSaveOutcome {
    const results = domains.results()
    const failed = results.find((result) => result.phase === "write")
    const pending = results.find((result) => result.phase === "refresh")
    return {
      phase: failed ? "write" : pending ? "refresh" : "complete",
      error: failed?.error ?? pending?.error,
      domains: results,
    }
  }

  function updateResultStatus() {
    setRefreshPending(domains.pending())
    setFailedDomains(
      ctx.domainSummaries().filter((domain) => domains.failures().some((failure) => failure.domain === domain.id)),
    )
    const outcome = domainOutcome()
    setStatus(
      outcome.phase === "write"
        ? domains.results().some((result) => result.phase !== "write")
          ? "partial"
          : "error"
        : outcome.phase === "refresh"
          ? "refresh"
          : "saved",
    )
    return outcome
  }

  async function retryRead(): Promise<SettingsSaveOutcome> {
    if (status() === "saving") return domainOutcome()
    setStatus("saving")
    try {
      await domains.reconcile()
      setExplicitDirty(Object.keys(ctx.serverPatch()).length > 0)
      return updateResultStatus()
    } catch (error) {
      setRefreshPending(true)
      setStatus(domains.failures().length ? "partial" : "refresh")
      return { ...domainOutcome(), error }
    }
  }

  async function saveServerChanges(): Promise<SettingsSaveOutcome> {
    if (status() === "saving") return { phase: "write" }
    if (domains.pending()) return retryRead()
    setStatus("saving")
    try {
      const patch = ctx.serverPatch()
      if (Object.keys(patch).length === 0) {
        setStatus("saved")
        return { phase: "complete" }
      }
      submittedDraft = ctx.serverDraft()
      const grouped = groupPatchByDomain(patch, ctx.domainSummaries())
      await ctx.preparePatchSave?.(patch, submittedDraft)
      const result = await domains.save(grouped)
      const failedPatch = Object.fromEntries(
        result.failed.flatMap(({ domain }) => Object.entries(grouped.get(domain as ConfigDomainSummary["id"]) ?? {})),
      )
      if (Object.keys(failedPatch).length) await ctx.rejectPatchSave?.(failedPatch, submittedDraft)
      const outcome = updateResultStatus()
      if (outcome.phase === "complete") await ctx.onPatchSaved?.(patch, submittedDraft)
      setExplicitDirty(Object.keys(ctx.serverPatch()).length > 0)
      return outcome
    } catch (error) {
      setStatus("error")
      return { phase: "write", error }
    }
  }

  function closeWithGuard() {
    if (status() === "saving" || ctx.closeBlocked?.()) return
    if (!ctx.hasAnyChanges() && !domains.pending()) {
      void Promise.resolve(ctx.discardChanges()).then(ctx.closeDialog)
      return
    }
    ctx.showConfirm({
      ...discardSettingsConfirm(),
      onConfirm: ctx.discardChanges,
      onConfirmed: ctx.closeDialog,
    })
  }

  return {
    saveServerChanges,
    retryRead,
    refreshPending,
    closeWithGuard,
    status,
    failedDomains,
    explicitDirty: () => {
      status()
      return explicitDirty() || domains.pending()
    },
  }
}
