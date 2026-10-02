export type SettingsDomainReceipt = { config: Record<string, unknown>; changedFields: string[] }
export type SettingsDomainResult = { domain: string; phase: "complete" | "write" | "refresh"; error?: unknown }

export function createSettingsDomainSave(
  write: (domain: string, config: Record<string, unknown>) => Promise<SettingsDomainReceipt>,
  refresh: (receipt: SettingsDomainReceipt) => Promise<void>,
) {
  let pendingReceipt: SettingsDomainReceipt | undefined
  let results: SettingsDomainResult[] = []
  const failures = () => results.filter((result) => result.phase === "write")

  async function reconcile() {
    if (!pendingReceipt) return
    const receipt = pendingReceipt
    await refresh(receipt)
    if (pendingReceipt === receipt) {
      pendingReceipt = undefined
      results = results.map((result) =>
        result.phase === "refresh" ? { domain: result.domain, phase: "complete" } : result,
      )
    }
  }

  async function save(grouped: Map<string, Record<string, unknown>>) {
    await reconcile()
    const entries = [...grouped.entries()]
    const writes = await Promise.allSettled(entries.map(([domain, config]) => write(domain, config)))
    const receipts: SettingsDomainReceipt[] = []
    results = writes.map((result, index) => {
      const domain = entries[index]![0]
      if (result.status === "rejected") return { domain, phase: "write", error: result.reason }
      receipts.push(result.value)
      return { domain, phase: "refresh" }
    })
    if (receipts.length) {
      pendingReceipt = {
        config: Object.assign({}, ...receipts.map((receipt) => receipt.config)),
        changedFields: [...new Set(receipts.flatMap((receipt) => receipt.changedFields))],
      }
      try {
        await reconcile()
      } catch (error) {
        results = results.map((result) => (result.phase === "refresh" ? { ...result, error } : result))
      }
    }
    return { failed: failures(), results }
  }
  return { save, reconcile, pending: () => Boolean(pendingReceipt), failures, results: () => results }
}
