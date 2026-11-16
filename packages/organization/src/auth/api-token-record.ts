import { z } from "zod"
import {
  OrganizationApiTokenProtocol as Protocol,
  OrganizationIdentity as Identity,
} from "@ericsanchezok/synergy-organization-protocol"

export const ApiTokenRecord = Protocol.Metadata.extend({
  schemaVersion: z.literal(1),
  tokenHash: Identity.Token,
  authRevision: Identity.Revision,
  deploymentIncarnation: Identity.ID,
})
export type ApiTokenRecord = z.infer<typeof ApiTokenRecord>
export const ApiTokenReceipt = z.strictObject({ requestHash: Identity.Token, tokenID: Identity.ID })
export const ApiTokenIndex = z.strictObject({ tokenID: Identity.ID })
export const apiTokenKeys = {
  record: (tokenID: string) => ["organization-api-tokens", "records", tokenID],
  hash: (tokenHash: string) => ["organization-api-tokens", "hashes", tokenHash],
  owner: (accountID: string) => ["organization-api-tokens", "owners", accountID],
  receipt: (accountID: string, requestID: string) => ["organization-api-tokens", "receipts", accountID, requestID],
}
