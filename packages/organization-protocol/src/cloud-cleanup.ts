import { z } from "zod"
import { OrganizationExecutionProtocol as Execution } from "./execution.js"
import { OrganizationIdentity as Identity } from "./identity.js"
import { SigningSignature, signedProtocol } from "./signature.js"

export namespace OrganizationCloudCleanupProtocol {
  const Original = z.strictObject({ scopeID: Identity.ID, environmentID: Identity.ID })
  const Use = Original.extend({ useID: z.string().min(1).max(4096), useHash: z.string().regex(/^[a-f0-9]{64}$/) })
  export const Candidate = z.discriminatedUnion("kind", [
    Original.extend({ kind: z.literal("execution"), id: Identity.ID, digest: z.string().regex(/^[a-f0-9]{64}$/) }),
    Use.extend({ kind: z.literal("preparation") }),
    Use.extend({ kind: z.literal("admission") }),
  ])
  export type Candidate = z.infer<typeof Candidate>
  const Retention = { version: z.literal(1), authority: Execution.InspectionRequest }
  export const DiscoveryProof = z
    .strictObject({
      ...Retention,
      purpose: z.literal("organization-environment-cleanup-discovery"),
      page: z.strictObject({
        limit: z.coerce.number().int().min(1).max(32).default(16),
        cursor: z.string().max(2048).optional(),
      }),
    })
    .meta({ ref: "OrgCloudCleanupDiscoveryProof" })
  export const DiscoveryRequest = z
    .strictObject({ proof: DiscoveryProof, signature: SigningSignature })
    .meta({ ref: "OrgCloudCleanupDiscoveryRequest" })
  export type DiscoveryRequest = z.infer<typeof DiscoveryRequest>
  const discoveries = signedProtocol(DiscoveryProof, "synergy.organization.environment.cleanup-discovery.v1\n")
  export const signDiscovery = discoveries.sign
  export const verifyDiscovery = discoveries.verify
  export const Page = z
    .strictObject({
      version: z.literal(1),
      grantID: Identity.ID,
      generation: z.number().int().positive().safe(),
      items: z.array(Candidate).max(32),
      cursor: z.string().max(2048).optional(),
    })
    .meta({ ref: "OrgCloudCleanupPage" })
  export type Page = z.infer<typeof Page>
  export const ReconciliationProof = z
    .strictObject({
      ...Retention,
      purpose: z.literal("organization-environment-cleanup-reconciliation"),
      action: z.enum(["inspect", "retire"]),
      candidate: Candidate,
    })
    .meta({ ref: "OrgCloudCleanupReconciliationProof" })
  export const ReconciliationRequest = z
    .strictObject({ proof: ReconciliationProof, signature: SigningSignature })
    .meta({ ref: "OrgCloudCleanupReconciliationRequest" })
  export type ReconciliationRequest = z.infer<typeof ReconciliationRequest>
  const reconciliations = signedProtocol(
    ReconciliationProof,
    "synergy.organization.environment.cleanup-reconciliation.v1\n",
  )
  export const signReconciliation = reconciliations.sign
  export const verifyReconciliation = reconciliations.verify
  export const Result = z
    .strictObject({ candidate: Candidate, state: z.enum(["pending", "released", "absent"]) })
    .meta({ ref: "OrgCloudCleanupResult" })
  export type Result = z.infer<typeof Result>
}
