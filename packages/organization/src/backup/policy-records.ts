import { z } from "zod"
import { AuthorityJournal } from "@ericsanchezok/synergy-harness/storage/authority-journal"
import { OrganizationInstallationReference } from "./installation-reference"
import { OrganizationSourceRetirement } from "./source-retirement"

export const OrganizationCurrentPolicyReceipt = z.strictObject({
  version: z.literal(1),
  target: OrganizationInstallationReference,
  source: OrganizationSourceRetirement.Reference,
  checkpoint: AuthorityJournal.Checkpoint,
  appliedAt: z.number().int().nonnegative().safe(),
})
export const currentPolicyKey = (installationID: string) => ["organization-recovery", "current-policy", installationID]
