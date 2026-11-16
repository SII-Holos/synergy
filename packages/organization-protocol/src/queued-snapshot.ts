import { z } from "zod"
import { OrganizationIdentity as Identity } from "./identity.js"
import { OrganizationProtocol as Protocol } from "./core.js"
import { SigningSignature, digestProtocol, signedProtocol } from "./signature.js"

export namespace OrganizationQueuedSnapshotProtocol {
  const count = z.number().int().nonnegative().safe()
  const nativeID = z.string().min(1)
  export const Item = z.strictObject({
    version: z.literal(1),
    sessionID: nativeID,
    rootID: nativeID,
    grantID: nativeID,
    acceptedHash: Protocol.Digest,
    entryID: nativeID,
    inboxID: nativeID,
    inboxRevision: count,
    inboxHash: Protocol.Digest,
    pausedSince: count,
    controlVersion: count,
    commandSeq: count,
    intakeSeq: count,
  })
  export type Item = z.infer<typeof Item>
  const Items = z.array(Item).superRefine((items, context) => {
    const roots = new Set<string>()
    const entries = new Set<string>()
    for (const [index, item] of items.entries()) {
      const root = JSON.stringify([item.sessionID, item.rootID])
      if (roots.has(root) || entries.has(item.entryID))
        context.addIssue({ code: "custom", path: [index], message: "Queued snapshot repeats a root or native entry" })
      roots.add(root)
      entries.add(item.entryID)
    }
  })
  export function digest(items: readonly Item[]) {
    const selected = Items.parse(items).sort((left, right) => {
      for (const field of ["sessionID", "rootID", "entryID"] as const) {
        if (left[field] !== right[field]) return left[field] < right[field] ? -1 : 1
      }
      return 0
    })
    return digestProtocol(z.array(Item), "synergy.organization.native-queued-snapshot.items.v1\n", selected)
  }
  export const Proof = z.strictObject({
    version: z.literal(1),
    purpose: z.literal("native-queued-snapshot"),
    orgID: Identity.ID,
    deploymentIncarnation: Identity.ID,
    runtimeID: Identity.ID,
    namespaceHash: Protocol.Digest,
    maintenanceID: Identity.ID,
    count,
    itemsHash: Protocol.Digest,
  })
  export type Proof = z.infer<typeof Proof>
  export const SignedProof = z.strictObject({ proof: Proof, signature: SigningSignature })
  export type SignedProof = z.infer<typeof SignedProof>
  const signatures = signedProtocol(Proof, "synergy.organization.native-queued-snapshot.proof.v1\n")
  export const sign = signatures.sign
  export const verify = signatures.verify
}
