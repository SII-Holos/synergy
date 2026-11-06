import { UsageQuery } from "../usage/query"
import { UsageMigration } from "../usage/migration"
import { UsageLedger } from "../usage/ledger"
export { UsageSchema } from "../usage/schema"

export namespace Usage {
  export const Summary = UsageQuery.Summary
  export const Page = UsageQuery.Page
  export async function summary(input: Parameters<typeof UsageQuery.summary>[0] = {}) {
    if (input.scopeID && input.sessionID)
      await UsageMigration.prepare({ kind: "session", scopeID: input.scopeID, sessionID: input.sessionID })
    return UsageQuery.summary(input)
  }
  export const records = UsageQuery.records
  export const collect = UsageQuery.collect
  export const summarize = UsageQuery.summarize
  export const clear = UsageLedger.clear
  export const rebuild = UsageMigration.start
  export const rebuildStatus = UsageMigration.status
  export const service = UsageMigration.service
  export const preserveOwner = UsageMigration.preserve
  export const reconcileTransfer = UsageLedger.reconcileTransfer
  export const Updated = UsageLedger.Updated
}
