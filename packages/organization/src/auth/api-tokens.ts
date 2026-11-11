import { z } from "zod"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import {
  OrganizationApiTokenProtocol as Protocol,
  OrganizationIdentity as Identity,
  OrganizationProtocol,
} from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationRecord as Record } from "../storage/records"
import { OrganizationStoragePath as Keys } from "../storage/path"
import { authorize, projectExecutionRole } from "../authorization"
import { authenticateHuman, type Credentials } from "./session"
import { ApiTokenRecord, ApiTokenReceipt, ApiTokenIndex, apiTokenKeys as keys } from "./api-token-record"
import { digest, token } from "./secret"
import { fail, revision } from "../error"
import { OrganizationAuthorityHistory as History } from "../authority-history"

function metadata(record: ApiTokenRecord) {
  return Protocol.Metadata.parse({
    tokenID: record.tokenID,
    orgID: record.orgID,
    accountID: record.accountID,
    projectID: record.projectID,
    label: record.label,
    operations: record.operations,
    revision: record.revision,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    ...(record.revokedAt === undefined ? {} : { revokedAt: record.revokedAt }),
  })
}

export namespace OrganizationApiTokens {
  export async function create(credentials: Credentials, value: Protocol.Create) {
    const input = Protocol.Create.parse(value)
    const requestHash = digest(JSON.stringify(input))
    const secret = `sy_api_${token()}`
    return History.credentials(credentials, "api-token.create", async () => {
      const human = await authenticateHuman(credentials)
      const current = await authorize(credentials, "project.read", { projectID: input.projectID })
      const previous = await Record.read(ApiTokenReceipt, keys.receipt(human.account.accountID, input.requestID))
      if (previous) {
        if (previous.requestHash !== requestHash)
          fail("REVISION_CONFLICT", "The request identity has different token settings")
        const record = await Record.read(ApiTokenRecord, keys.record(previous.tokenID))
        if (!record || record.accountID !== human.account.accountID)
          fail("SERVICE_UNAVAILABLE", "The API token receipt is incomplete")
        return Protocol.Created.parse({ metadata: metadata(record), secretUnavailable: true })
      }
      if (input.expiresAt <= Date.now()) fail("INVALID_REQUEST", "Choose an API token expiry in the future")
      const execute = input.operations.some((operation) =>
        ["sessions.create", "sessions.input", "sessions.continue", "sessions.configure"].includes(operation),
      )
      const stop = input.operations.some((operation) =>
        ["sessions.pause", "sessions.cancel", "sessions.reply"].includes(operation),
      )
      if ((execute && !current.view.permissions.execute) || (stop && !projectExecutionRole(current.view.role)))
        fail("PERMISSION_DENIED", "The token cannot exceed your current project permissions")
      const deployment = OrganizationProtocol.Deployment.parse(await Storage.read(Keys.deployment()))
      if (deployment.orgID !== human.account.orgID)
        fail("PERMISSION_DENIED", "The project belongs to another organization")
      const { requestID: _, ...settings } = input
      const record = ApiTokenRecord.parse({
        ...settings,
        schemaVersion: 1,
        tokenID: crypto.randomUUID(),
        orgID: human.account.orgID,
        accountID: human.account.accountID,
        revision: 1,
        createdAt: Date.now(),
        tokenHash: digest(secret),
        authRevision: human.account.authRevision,
        deploymentIncarnation: deployment.deploymentIncarnation,
      })
      await Storage.write(keys.record(record.tokenID), record)
      await Storage.write(keys.hash(record.tokenHash), { tokenID: record.tokenID })
      await Storage.write([...keys.owner(record.accountID), record.tokenID], { tokenID: record.tokenID })
      await Storage.write(keys.receipt(record.accountID, input.requestID), { requestHash, tokenID: record.tokenID })
      return Protocol.Created.parse({ metadata: metadata(record), token: secret, secretUnavailable: false })
    })
  }

  export async function list(credentials: Credentials, value: Partial<Identity.Page>) {
    const input = Identity.Page.parse(value)
    return Storage.snapshot(async () => {
      const { account } = await authenticateHuman(credentials)
      const prefix = keys.owner(account.accountID)
      const rows = await Storage.query({
        prefix,
        after: input.cursor ? [...prefix, input.cursor] : undefined,
        limit: input.limit + 1,
      })
      const selected = rows.slice(0, input.limit)
      const items = await Promise.all(
        selected.map(async (row) => {
          const index = ApiTokenIndex.parse(row.value)
          const record = await Record.read(ApiTokenRecord, keys.record(index.tokenID))
          if (!record || record.accountID !== account.accountID || record.orgID !== account.orgID)
            fail("SERVICE_UNAVAILABLE", "The API token index is inconsistent")
          return metadata(record)
        }),
      )
      return Protocol.Page.parse({ items, ...(rows.length > input.limit ? { cursor: items.at(-1)?.tokenID } : {}) })
    })
  }

  export async function revoke(credentials: Credentials, tokenID: string, value: z.infer<typeof Protocol.Revoke>) {
    Identity.ID.parse(tokenID)
    const input = Protocol.Revoke.parse(value)
    return History.credentials(credentials, "api-token.revoke", async () => {
      const { account } = await authenticateHuman(credentials)
      const record = await Record.read(ApiTokenRecord, keys.record(tokenID))
      if (!record || record.accountID !== account.accountID || record.orgID !== account.orgID)
        fail("NOT_FOUND", "API token not found")
      if (record.revokedAt !== undefined && input.expectedRevision === record.revision - 1) return metadata(record)
      revision(input.expectedRevision, record.revision)
      if (record.revokedAt !== undefined) return metadata(record)
      const changed = { ...record, revokedAt: Date.now(), revision: record.revision + 1 }
      await Storage.write(keys.record(tokenID), changed)
      return metadata(changed)
    })
  }
}
