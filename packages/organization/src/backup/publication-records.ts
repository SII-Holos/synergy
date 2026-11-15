import { z } from "zod"
import { createHash } from "node:crypto"
import { AuthorityJournal } from "@ericsanchezok/synergy-harness/storage/authority-journal"
import {
  OrganizationCommandProtocol as Command,
  OrganizationProtocol,
  OrganizationRuntimeProtocol as Runtime,
} from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationRecord as Record } from "../storage/records"
import { OrganizationInstallationReference } from "./installation-reference"
import { OrganizationSourceRetirement } from "./source-retirement"
import { OrganizationServiceNative as Native } from "./service-native"
import { fail } from "../error"

export namespace OrganizationRecoveryPublicationRecords {
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
  export const key = (id: string) => ["organization-recovery", "publication", id]
  export const hostedKey = (id: string, runtimeID: string) => [...key(id), "hosted", runtimeID]
  const writers = z.strictObject({
    hosted: z.number().int().nonnegative().safe(),
    namespaceHash: OrganizationProtocol.Digest,
  })
  const fields = {
    target: OrganizationInstallationReference,
    source: OrganizationSourceRetirement.Reference,
    checkpoint: AuthorityJournal.Checkpoint,
    identity: Command.SigningIdentity,
    settings: Native.Manifest.shape.startup.shape.settings,
    publicOrigin: z.string().url(),
    publishedAt: z.number().int().nonnegative().safe(),
  }
  export const Receipt = z.union([
    z.strictObject({
      ...fields,
      version: z.literal(1),
      writers: z.undefined().optional(),
      sourceIdentity: z.undefined().optional(),
    }),
    z.strictObject({ ...fields, version: z.literal(2), writers, sourceIdentity: z.undefined().optional() }),
    z
      .strictObject({
        ...fields,
        version: z.literal(3),
        sourceIdentity: Command.SigningIdentity,
        writers: writers.optional(),
      })
      .refine(
        (value) =>
          value.sourceIdentity.orgID === value.identity.orgID &&
          value.sourceIdentity.deploymentIncarnation !== value.identity.deploymentIncarnation &&
          value.sourceIdentity.keyID !== value.identity.keyID &&
          value.sourceIdentity.publicKey !== value.identity.publicKey,
        "Recovery signing history requires its distinct original and published identities",
      ),
  ])
  export type Receipt = z.infer<typeof Receipt>
  export const Hosted = z.strictObject({
    version: z.literal(1),
    target: OrganizationInstallationReference,
    namespaceHash: OrganizationProtocol.Digest,
    sourceReferenceHash: OrganizationProtocol.Digest,
    original: Runtime.HostedRegistrationRecord,
    published: Runtime.HostedRegistrationRecord,
  })
  export function validate(value: unknown, installationID: string) {
    const receipt = Receipt.parse(value)
    if (
      receipt.target.installationID !== installationID ||
      hash(receipt.target) !== hash(receipt.source.target) ||
      hash(receipt.checkpoint) !== hash(receipt.source.current.checkpoint) ||
      receipt.identity.deploymentIncarnation !== receipt.target.incarnation ||
      ("writers" in receipt &&
        receipt.writers &&
        receipt.writers.namespaceHash !== receipt.source.current.namespaceHash)
    )
      fail("PROTOCOL_MISMATCH", "Historical recovery publication has another original source or target")
    return receipt
  }
  export function validateHosted(value: unknown, receipt: Receipt, runtimeID: string) {
    const mapping = Hosted.parse(value)
    const published = Runtime.HostedRegistrationRecord.parse({
      ...mapping.original,
      deploymentIncarnation: receipt.identity.deploymentIncarnation,
      revision: mapping.original.revision + 1,
    })
    if (
      !receipt.writers ||
      hash(mapping.target) !== hash(receipt.target) ||
      mapping.namespaceHash !== receipt.writers.namespaceHash ||
      mapping.original.runtimeID !== runtimeID ||
      mapping.original.orgID !== receipt.identity.orgID ||
      hash(mapping.published) !== hash(published) ||
      (receipt.version === 3 && mapping.original.deploymentIncarnation !== receipt.sourceIdentity.deploymentIncarnation)
    )
      fail("PROTOCOL_MISMATCH", "Historical Hosted mapping has another original publication")
    return mapping
  }
  export function historical(reader: Record.HistoricalReader, address: string[], value: unknown) {
    if (address[0] !== "organization-recovery" || address[1] !== "publication") return false
    if (address.length === 3) validate(value, address[2]!)
    else if (address.length === 5 && address[3] === "hosted")
      validateHosted(value, validate(reader.read(Receipt, key(address[2]!)), address[2]!), address[4]!)
    else fail("PROTOCOL_MISMATCH", "Historical recovery publication has an unknown owner key")
    return true
  }
  export function* lineage(reader: Record.HistoricalReader, current: Command.SigningIdentity) {
    let selected = current
    const visited = new Set<string>()
    while (true) {
      const identity = JSON.stringify([selected.orgID, selected.deploymentIncarnation, selected.keyID])
      if (visited.has(identity)) fail("PROTOCOL_MISMATCH", "Recovery signing history contains a cycle")
      visited.add(identity)
      let previous: Extract<Receipt, { version: 3 }> | undefined
      for (const row of reader.entries(["organization-recovery", "publication"])) {
        if (row.key.length !== 3) continue
        const receipt = validate(row.value, row.key[2]!)
        const tuple = JSON.stringify([
          receipt.identity.orgID,
          receipt.identity.deploymentIncarnation,
          receipt.identity.keyID,
        ])
        if (tuple !== identity) continue
        if (receipt.identity.publicKey !== selected.publicKey)
          fail("PROTOCOL_MISMATCH", "Recovery signing history has conflicting public keys")
        if (receipt.version !== 3) continue
        if (previous && hash(previous) !== hash(receipt))
          fail("PROTOCOL_MISMATCH", "Recovery signing history has conflicting original publications")
        previous = receipt
      }
      if (!previous) return
      yield previous
      selected = previous.sourceIdentity
    }
  }
}
