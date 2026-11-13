import { z } from "zod"
import { OrganizationHandoffProtocol as Handoff } from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationHandoffRecovery as Recovery } from "@ericsanchezok/synergy-organization-protocol"
import type { Migration } from "@ericsanchezok/synergy-harness/migration/types"
import { upgradeAccessRecord } from "@ericsanchezok/synergy-harness/migration/import"

const fields = { plan: Handoff.MachinePlan, fact: Handoff.Proof }
const Previous = z
  .strictObject({ version: z.literal(1), ...fields })
  .refine(
    (value) =>
      !Handoff.isNativeTargetMapping(value.plan.workspacePlan?.mapping) &&
      !["target-difference", "target-preview-released"].includes(value.fact.purpose),
    "Version-one target receipts require their original reader",
  )
export const HandoffTargetRecord = z
  .strictObject({ version: z.literal(3), plan: z.union([Handoff.MachinePlan, Recovery.Permit]), fact: Handoff.Proof })
  .superRefine((value, context) => {
    const invalid = (message: string) => context.addIssue({ code: "custom", message })
    const { plan, fact } = value
    const mapping = plan.workspacePlan?.mapping
    const native = Handoff.isNativeTargetMapping(mapping)
    const adopting = native && mapping.target.kind === "existing"
    if (
      plan.purpose === "handoff-target-cleanup" &&
      (!["target-never-activate", "target-preview-released"].includes(fact.purpose) ||
        plan.operation !== "retire-target")
    )
      invalid("Recovery receipts cannot prepare, preview or activate a target")
    if (
      plan.purpose === "handoff-target-cleanup" &&
      fact.purpose === "target-never-activate" &&
      plan.preparedHash !== undefined &&
      plan.preparedHash !== fact.preparedHash
    )
      invalid("Recovery receipt changed its explicitly retained preparation hash")
    if (
      (Object.keys(Handoff.Binding.shape) as (keyof z.infer<typeof Handoff.Binding>)[]).some(
        (key) => plan[key] !== fact[key],
      ) ||
      fact.manifestHash !== plan.manifestHash
    )
      invalid("Destination receipt has another exact frozen binding")
    const operation = {
      "target-prepared": "prepare-target",
      "target-activated": "activate-target",
      "target-never-activate": "retire-target",
      "target-difference": "preview-target",
      "target-preview-released": "retire-target",
    } as const
    if (
      !fact.purpose.startsWith("target-") ||
      !(fact.purpose in operation) ||
      plan.operation !== operation[fact.purpose as keyof typeof operation]
    )
      invalid("Destination receipt has another native operation")
    if (
      fact.purpose === "target-difference" &&
      (!adopting ||
        plan.frozen?.proof.purpose !== "source-frozen" ||
        fact.difference.sourceSnapshotHash !== plan.frozen.proof.workspaceSourceHash ||
        fact.difference.mappingPlanRevision !== plan.mappingPlanRevision)
    )
      invalid("Native difference has another complete frozen source")
    if (
      fact.purpose === "target-preview-released" &&
      (!native || fact.diffHash !== (plan.workspacePlan?.difference?.diffHash ?? null))
    )
      invalid("Inactive native release has another accepted preview")
    if (fact.purpose === "target-prepared") {
      if (
        native
          ? !fact.workspaceNativeReceiptHash ||
            (plan.workspacePlan &&
            Handoff.isNativeTargetMapping(plan.workspacePlan.mapping) &&
            plan.workspacePlan.mapping.target.kind === "existing"
              ? !plan.workspacePlan?.differenceConsent ||
                fact.workspaceDifferenceHash !== plan.workspacePlan.differenceConsent.diffHash
              : fact.workspaceDifferenceHash !== undefined)
          : !!fact.workspaceNativeReceiptHash || !!fact.workspaceDifferenceHash
      )
        invalid("Prepared target has another complete native receipt or consent")
    }
  })
export function readHandoffTargetRecord(key: string[], value: unknown) {
  return HandoffTargetRecord.parse(upgradeAccessRecord(key, value))
}
export const handoffTargetMigration: Migration = {
  id: "20261113-organization-handoff-target-difference",
  description: "Version original destination receipts for inactive native target differences",
  scope: "global",
  execution: "record",
  async up() {},
  upgradeRecord(key, value) {
    if (key.length !== 5 || key[0] !== "organization_handoff_target" || value.version !== 1) return
    if (!["prepared", "activated", "retired"].includes(key[4]!))
      throw new Error("Unknown version-one destination receipt")
    Previous.parse(value)
    value.version = 2
    HandoffTargetRecord.parse({ ...value, version: 3 })
  },
}
export const handoffTargetRecoveryMigration: Migration = {
  id: "20261113-organization-handoff-target-recovery",
  description: "Retain only inactive target recovery permits through the original receipt owner",
  scope: "global",
  execution: "record",
  dependsOn: ["organization-sync/20261113-organization-handoff-target-difference"],
  async up() {},
  upgradeRecord(key, value) {
    if (key.length !== 5 || key[0] !== "organization_handoff_target" || value.version !== 2) return
    z.strictObject({ version: z.literal(2), ...fields }).parse(value)
    value.version = 3
    HandoffTargetRecord.parse(value)
  },
}
export type HandoffTargetPlan = z.infer<typeof HandoffTargetRecord>["plan"]
