import { OrganizationProtocol } from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationRecord as Record } from "../storage/records"
import { OrganizationStoragePath as Keys } from "../storage/path"
import { digest } from "./secret"
import { fail } from "../error"

export namespace OrganizationInviteHistory {
  const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
  function invalid(): never {
    return fail("PROTOCOL_MISMATCH", "Historical invitation metadata differs from its original consumption and catalog")
  }
  function invite(source: Record.HistoricalReader, tokenHash: string) {
    const value = source.read(Record.Invite, Keys.invite(tokenHash))
    const deployment = source.read(OrganizationProtocol.Deployment, Keys.deployment())
    const issuer = source.read(Record.Account, Keys.account(value.createdBy))
    if (
      value.tokenHash !== tokenHash ||
      value.orgID !== deployment.orgID ||
      issuer.accountID !== value.createdBy ||
      issuer.orgID !== value.orgID ||
      value.issuerAuthRevision > issuer.authRevision ||
      source.read(Record.InviteIndex, Keys.inviteID(value.orgID, value.inviteID)).tokenHash !== tokenHash ||
      source.read(Record.InviteIndex, Keys.issuedInvite(value.orgID, value.createdBy, value.inviteID)).tokenHash !==
        tokenHash
    )
      invalid()
    const consumed = value.consumed
    if (consumed) {
      const original = consumed.result
      const current = source.read(Record.Account, Keys.account(consumed.accountID))
      if (
        value.revokedAt !== undefined ||
        original.accountID !== consumed.accountID ||
        original.orgID !== value.orgID ||
        original.role !== value.role ||
        original.state !== "active" ||
        current.accountID !== original.accountID ||
        current.orgID !== original.orgID ||
        current.loginName !== original.loginName ||
        current.createdAt !== original.createdAt ||
        current.revision < original.revision ||
        current.authRevision < original.authRevision ||
        source.read(Record.LoginIndex, Keys.loginName(digest(original.loginName))).accountID !== original.accountID
      )
        invalid()
    }
    return value
  }
  export function validate(source: Record.HistoricalReader, key: string[], value: unknown) {
    if (key[0] !== "organization") return false
    if (key[1] === "invites") {
      const original = Record.Invite.parse(value)
      if (!equal(key, Keys.invite(original.tokenHash)) || !equal(original, invite(source, original.tokenHash)))
        invalid()
      return true
    }
    if (key[1] !== "invite-catalog" && key[1] !== "issued-invites") return false
    const index = Record.InviteIndex.parse(value)
    const original = invite(source, index.tokenHash)
    const expected =
      key[1] === "invite-catalog"
        ? Keys.inviteID(original.orgID, original.inviteID)
        : Keys.issuedInvite(original.orgID, original.createdBy, original.inviteID)
    if (!equal(key, expected)) invalid()
    return true
  }
}
