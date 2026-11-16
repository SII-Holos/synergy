import { OrganizationCommandProtocol as Command } from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationRecord as Record } from "./storage/records"
import { OrganizationStoragePath as Keys } from "./storage/path"
import { OrganizationRecoveryPublicationRecords as Publications } from "./backup/publication-records"
import { fail } from "./error"

export namespace OrganizationSigningHistory {
  export type Selector = Pick<Command.SigningIdentity, "orgID" | "deploymentIncarnation" | "keyID">
  export function current(reader: Record.HistoricalReader) {
    const stored = reader.read(Record.SigningIdentity, Keys.signingIdentity())
    return Command.SigningIdentity.parse({
      schemaVersion: 1,
      orgID: stored.orgID,
      deploymentIncarnation: stored.deploymentIncarnation,
      keyID: stored.keyID,
      publicKey: stored.publicKey,
    })
  }
  export function identity(reader: Record.HistoricalReader, expected: Selector) {
    const latest = current(reader)
    const matches = (value: Command.SigningIdentity) =>
      value.orgID === expected.orgID &&
      value.deploymentIncarnation === expected.deploymentIncarnation &&
      value.keyID === expected.keyID
    let selected = matches(latest) ? latest : undefined
    for (const publication of Publications.lineage(reader, latest)) {
      const original = publication.sourceIdentity
      if (!matches(original)) continue
      if (selected && selected.publicKey !== original.publicKey)
        fail("PROTOCOL_MISMATCH", "Historical signature has conflicting original public identities")
      selected = original
    }
    if (selected) return selected
    return fail("PROTOCOL_MISMATCH", "Historical signature lacks its original retained publication identity")
  }
}
