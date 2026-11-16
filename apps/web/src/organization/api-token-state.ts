import { OrganizationApiTokenProtocol as Token } from "@ericsanchezok/synergy-organization-protocol"
import { z } from "zod"
import { Persist } from "@/utils/persist"

const Pending = z.strictObject({ request: Token.Create, issued: Token.Metadata.optional() })
type IssuanceStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">

export function createOrganizationApiTokenIssuance(
  storage: IssuanceStorage,
  connection: string,
  orgID: string,
  accountID: string,
) {
  const target = Persist.connection(connection, `organization-api-token:${accountID}`)
  const key = `${target.storage}:${target.key}`
  function pending() {
    const value = storage.getItem(key)
    return value ? Pending.parse(JSON.parse(value)) : undefined
  }
  function matches(request: Token.Create, metadata: Token.Metadata) {
    return (
      metadata.orgID === orgID &&
      metadata.accountID === accountID &&
      metadata.projectID === request.projectID &&
      metadata.label === request.label &&
      metadata.expiresAt === request.expiresAt &&
      JSON.stringify([...metadata.operations].sort()) === JSON.stringify([...request.operations].sort())
    )
  }
  return {
    pending,
    begin(value: Token.Create) {
      if (pending()) throw new Error("Recover the original token issuance before creating another token")
      const request = Token.Create.parse(value)
      storage.setItem(key, JSON.stringify(Pending.parse({ request })))
      return request
    },
    accept(value: unknown) {
      const current = pending()
      const created = Token.Created.parse(value)
      if (
        !current ||
        !matches(current.request, created.metadata) ||
        (current.issued && current.issued.tokenID !== created.metadata.tokenID)
      )
        throw new Error("The token issuance could not be confirmed")
      if (created.token || created.metadata.revokedAt !== undefined) storage.removeItem(key)
      else storage.setItem(key, JSON.stringify(Pending.parse({ ...current, issued: created.metadata })))
      return created
    },
    revoked(value: unknown) {
      const current = pending()
      const metadata = Token.Metadata.parse(value)
      if (
        !current?.issued ||
        !matches(current.request, metadata) ||
        current.issued.tokenID !== metadata.tokenID ||
        metadata.revokedAt === undefined
      )
        throw new Error("The original token revocation could not be confirmed")
      storage.removeItem(key)
      return metadata
    },
  }
}
