import { z } from "zod"
import { AuthorityJournal } from "@ericsanchezok/synergy-harness/storage/authority-journal"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { OrganizationProtocol } from "@ericsanchezok/synergy-organization-protocol"

export const OrganizationCurrentAuthorityInfo = z.strictObject({
  checkpoint: AuthorityJournal.Checkpoint,
  after: AuthorityJournal.Checkpoint.optional(),
  maintenance: RuntimeMaintenance.Info,
  namespaceHash: OrganizationProtocol.Digest,
  nativeHash: OrganizationProtocol.Digest,
  clientDefinitionsHash: OrganizationProtocol.Digest,
})
