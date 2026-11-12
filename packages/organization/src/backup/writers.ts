import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"

const safeRoots = new Set([
  "meta",
  "storage_authority_journal",
  "runtime_maintenance",
  "organization-recovery",
  "organization-api-tokens",
])
const schemaMarkers = new Map([
  ["execution-grant-index-schema", { version: 1, complete: true }],
  ["execution-control-index-schema", { version: 1, complete: true }],
  ["transcript-schema", { schemaVersion: 1 }],
  ["transcript-window-schema", { schemaVersion: 3 }],
  ["task-projection-schema", { schemaVersion: 1 }],
])
const serviceRecords = new Set([
  "deployment",
  "info",
  "signing-identity",
  "accounts",
  "login-names",
  "logins",
  "authorization-codes",
  "client-grants",
  "client-access",
  "client-refresh",
  "invites",
  "invite-catalog",
  "invite-receipts",
  "resets",
  "bootstrap",
  "projects",
  "project-members",
  "project-access",
])
function blocked(category: string): never {
  throw new RuntimeMaintenance.Blocked({ message: "Service-only recovery requires reconciliation for " + category })
}

export namespace OrganizationRecoveryWriters {
  export async function assertServiceOnly() {
    const store = Storage.current().store
    if (store.hasUnpublishedOwners()) blocked("unpublished native owners")
    return Storage.snapshot(async (tx) => {
      for await (const entry of tx.exportEntries()) {
        if (entry.type === "receipt") {
          if (
            !entry.operationID.startsWith("storage-checkpoint:") &&
            !/^runtime-maintenance-begin:[a-f0-9]{64}$/.test(entry.operationID)
          )
            blocked("unclassified operation receipts")
          continue
        }
        if (entry.type === "event") blocked("unreconciled historical events")
        if (entry.type === "artifact") continue
        const [root, kind] = entry.key
        if (root === "organization") {
          const marker = kind && schemaMarkers.get(kind)
          if (
            (marker && entry.key.length === 2 && JSON.stringify(marker) === JSON.stringify(entry.value)) ||
            (kind === "transcript-window-schema" &&
              entry.key.length === 2 &&
              JSON.stringify(entry.value) === JSON.stringify({ schemaVersion: 2 }))
          )
            continue
          if (!kind || !serviceRecords.has(kind)) blocked("organization " + (kind ?? "owner"))
        } else if (!root || !safeRoots.has(root)) blocked("native " + (root ?? "owner"))
      }
      if (store.hasUnpublishedOwners()) blocked("unpublished native owners")
      return { version: 1 as const, externalWriters: 0 as const }
    })
  }
}
