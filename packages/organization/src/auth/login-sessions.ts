import { z } from "zod"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import type { Migration } from "@ericsanchezok/synergy-harness/migration/types"
import { OrganizationProtocol } from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationRecord as Record } from "../storage/records"
import { OrganizationStoragePath as Keys } from "../storage/path"
import { loadSigningAuthority } from "../signing"

const legacy = Record.Login.omit({ orgID: true, deploymentIncarnation: true }).extend({ schemaVersion: z.literal(1) })
const prefix = ["organization", "logins"]
function transactionOwner() {
  const runtime = RuntimeContext.current()
  const store = Storage.current().store
  const transaction = Storage.current().transaction
  const current = () => {
    if (
      RuntimeContext.current() !== runtime ||
      Storage.current().store !== store ||
      Storage.current().transaction !== transaction ||
      !Storage.inWriteTransaction()
    )
      throw new Error("Login session changes require their original write transaction")
  }
  current()
  return current
}
async function deployment(expected: OrganizationProtocol.Deployment, current: () => void) {
  current()
  const actual = OrganizationProtocol.Deployment.parse(await Storage.read(Keys.deployment()))
  current()
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error("Login session changes require the original deployment before publication")
}

export namespace OrganizationLoginSessions {
  export const migration: Migration = {
    id: "20261112-organization-login-deployment-identity",
    description: "Bind retained login sessions to their verified original deployment",
    scope: "global",
    execution: "startup",
    dependsOn: ["20261111-organization-authority-history"],
    async up(progress) {
      await Storage.transaction(async () => {
        const current = transactionOwner()
        const original = OrganizationProtocol.Deployment.parse(await Storage.read(Keys.deployment()))
        current()
        await loadSigningAuthority(original)
        current()
        let after: string[] | undefined
        let count = 0
        for (;;) {
          current()
          const rows = await Storage.query({ prefix, after, limit: 128 })
          current()
          if (!rows.length) break
          const records = rows.map((row) => {
            const old = legacy.safeParse(row.value)
            const record = old.success ? old.data : Record.Login.parse(row.value)
            if (row.key.length !== 3 || row.key[2] !== record.tokenHash)
              throw new Error("Login session storage identity is inconsistent")
            return { key: row.key, old: old.success ? old.data : undefined }
          })
          const ids = [...new Set(records.flatMap((row) => (row.old ? [row.old.accountID] : [])))]
          const accounts = await Storage.readMany<unknown>(ids.map(Keys.account))
          current()
          const owners = new Map(ids.map((id, index) => [id, Record.Account.parse(accounts[index])]))
          for (const row of records) {
            if (!row.old) continue
            const account = owners.get(row.old.accountID)
            if (!account || account.accountID !== row.old.accountID || account.orgID !== original.orgID)
              throw new Error("Legacy login session does not belong to the original organization")
            current()
            await Storage.write(
              row.key,
              Record.Login.parse({
                ...row.old,
                schemaVersion: 2,
                orgID: original.orgID,
                deploymentIncarnation: original.deploymentIncarnation,
              }),
            )
            current()
          }
          count += rows.length
          after = rows.at(-1)!.key
          progress(count, count + (rows.length === 128 ? 1 : 0))
        }
        await deployment(original, current)
      })
      progress(1, 1)
    },
  }

  export async function retireLegacyLogins(value: OrganizationProtocol.Deployment) {
    const expected = OrganizationProtocol.Deployment.parse(value)
    const current = transactionOwner()
    let complete = false
    let failure: { error: unknown } | undefined
    return Storage.transaction(
      async () => {
        try {
          await deployment(expected, current)
          let after: string[] | undefined
          let count = 0
          for (;;) {
            current()
            const rows = await Storage.query({ prefix, after, limit: 128 })
            current()
            if (!rows.length) break
            for (const row of rows) {
              const old = legacy.safeParse(row.value)
              const record = old.success ? old.data : Record.Login.parse(row.value)
              if (row.key.length !== 3 || row.key[2] !== record.tokenHash)
                throw new Error("Login session storage identity is inconsistent")
              if (!old.success) continue
              current()
              await Storage.remove(row.key)
              current()
              count++
            }
            after = rows.at(-1)!.key
          }
          await deployment(expected, current)
          complete = true
          return count
        } catch (error) {
          failure = { error }
          throw error
        }
      },
      {
        commitGuard: () => {
          if (failure) throw failure.error
          if (!complete) throw new Error("Legacy login retirement must complete before deployment publication")
        },
      },
    )
  }
}
