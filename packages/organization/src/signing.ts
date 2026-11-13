import { createPrivateKey, createPublicKey } from "node:crypto"
import { z } from "zod"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import {
  OrganizationCommandProtocol as Command,
  OrganizationProtocol,
  OrganizationRuntimeProtocol as Runtime,
  OrganizationGatewayProtocol as Gateway,
  OrganizationHandoffProtocol as Handoff,
  OrganizationHandoffRecovery as Recovery,
  OrganizationReadProtocol as Read,
  OrganizationInteractionProtocol as Interactions,
} from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationRecord as Record } from "./storage/records"
import { OrganizationStoragePath as Keys } from "./storage/path"
import { fail } from "./error"
import { AuthorityJournal } from "@ericsanchezok/synergy-harness/storage/authority-journal"

const priorSigningIdentity = Record.SigningIdentity.omit({ historyContractHash: true }).extend({
  schemaVersion: z.literal(1),
})

async function readSigningIdentity() {
  try {
    return await Record.read(Record.SigningIdentity, Keys.signingIdentity())
  } catch (error) {
    if (error instanceof z.ZodError) throw new Error("Organization signing identity is invalid")
    throw error
  }
}

export const OrganizationSigningMaterial = z.strictObject({
  keyID: Record.SigningIdentity.shape.keyID,
  publicKey: Record.SigningIdentity.shape.publicKey,
  pkcs8: Record.SigningIdentity.shape.pkcs8,
})
export type OrganizationSigningMaterial = z.infer<typeof OrganizationSigningMaterial>

export async function prepareSigningMaterial(): Promise<OrganizationSigningMaterial> {
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  return OrganizationSigningMaterial.parse({
    keyID: crypto.randomUUID(),
    publicKey: await Runtime.publicKey(keys.publicKey),
    pkcs8: Buffer.from(await crypto.subtle.exportKey("pkcs8", keys.privateKey)).toString("hex"),
  })
}

export async function validateSigningMaterial(input: OrganizationSigningMaterial): Promise<CryptoKey> {
  try {
    const material = OrganizationSigningMaterial.parse(input)
    const bytes = Buffer.from(material.pkcs8, "hex")
    try {
      const key = createPrivateKey({ key: bytes, type: "pkcs8", format: "der" })
      if (key.asymmetricKeyType !== "ed25519") throw new Error("Wrong signing algorithm")
      const publicKey = createPublicKey(key).export({ format: "jwk" }).x
      if (!publicKey || Buffer.from(publicKey, "base64url").toString("hex") !== material.publicKey)
        throw new Error("Mismatched signing key")
      return await crypto.subtle.importKey("pkcs8", bytes, "Ed25519", false, ["sign"])
    } finally {
      bytes.fill(0)
    }
  } catch {
    throw new Error("Organization signing credentials are invalid or unsupported")
  }
}

export async function initializeSigningIdentity() {
  const material = await prepareSigningMaterial()
  await Storage.transaction(async () => {
    const deployment = OrganizationProtocol.Deployment.parse(await Storage.read(Keys.deployment()))
    const [raw] = await Storage.readMany([Keys.signingIdentity()])
    const existing =
      raw === undefined
        ? undefined
        : priorSigningIdentity.safeParse(raw).success
          ? priorSigningIdentity.parse(raw)
          : Record.SigningIdentity.parse(raw)
    if (existing) {
      if (existing.orgID !== deployment.orgID || existing.deploymentIncarnation !== deployment.deploymentIncarnation)
        throw new Error("Organization signing identity does not match this deployment")
      return
    }
    await Storage.write(
      Keys.signingIdentity(),
      Record.SigningIdentity.parse({
        schemaVersion: 2,
        historyContractHash: AuthorityJournal.definition().hash,
        orgID: deployment.orgID,
        deploymentIncarnation: deployment.deploymentIncarnation,
        ...material,
      }),
    )
  })
}

export async function upgradeSigningIdentityForAuthorityHistory(contractHash: string) {
  if (!Storage.inWriteTransaction())
    throw new Error("Signing identity history migration requires its baseline transaction")
  const [raw] = await Storage.readMany([Keys.signingIdentity()])
  const prior = priorSigningIdentity.safeParse(raw)
  if (prior.success) {
    await Storage.write(
      Keys.signingIdentity(),
      Record.SigningIdentity.parse({ ...prior.data, schemaVersion: 2, historyContractHash: contractHash }),
    )
    return
  }
  const current = Record.SigningIdentity.parse(raw)
  if (current.historyContractHash !== contractHash)
    throw new Error("Organization signing history contract requires an owning migration")
}

export async function loadSigningAuthority(deployment: OrganizationProtocol.Deployment) {
  const stored = await readSigningIdentity()
  if (!stored || stored.orgID !== deployment.orgID || stored.deploymentIncarnation !== deployment.deploymentIncarnation)
    throw new Error("Organization signing identity is missing or does not match this deployment")
  const privateKey = await validateSigningMaterial({
    keyID: stored.keyID,
    publicKey: stored.publicKey,
    pkcs8: stored.pkcs8,
  })
  const { pkcs8: _, historyContractHash: _history, ...publicFields } = stored
  const identity = Object.freeze(Command.SigningIdentity.parse({ ...publicFields, schemaVersion: 1 }))
  return {
    identity,
    async signHandoffRecovery(value: Recovery.Permit): Promise<Recovery.SignedPermit> {
      const permit = Recovery.Permit.parse(value)
      if (
        permit.orgID !== identity.orgID ||
        permit.deploymentIncarnation !== identity.deploymentIncarnation ||
        permit.keyID !== identity.keyID ||
        permit.issuedAt > Date.now() ||
        permit.expiresAt <= Date.now()
      )
        fail("PERMISSION_DENIED", "Handoff cleanup belongs to another or expired signing authority")
      return { permit, signature: await Recovery.signPermit(permit, privateKey) }
    },
    async signHandoffSourceReceipt(value: Recovery.SourceReceiptPermit): Promise<Recovery.SignedSourceReceiptPermit> {
      const permit = Recovery.SourceReceiptPermit.parse(value)
      if (
        permit.orgID !== identity.orgID ||
        permit.deploymentIncarnation !== identity.deploymentIncarnation ||
        permit.keyID !== identity.keyID ||
        permit.issuedAt > Date.now() ||
        permit.expiresAt <= Date.now()
      )
        fail("PERMISSION_DENIED", "Source receipt inspection belongs to another current signing authority")
      return { permit, signature: await Recovery.signSourceReceipt(permit, privateKey) }
    },
    async signHandoffInspection(value: Handoff.InspectionPlan): Promise<Handoff.SignedInspectionPlan> {
      const plan = Handoff.InspectionPlan.parse(value)
      if (
        plan.orgID !== identity.orgID ||
        plan.deploymentIncarnation !== identity.deploymentIncarnation ||
        plan.keyID !== identity.keyID
      )
        fail("PROTOCOL_MISMATCH", "Handoff inspection belongs to another signing identity")
      return { plan, signature: await Handoff.signInspection(plan, privateKey) }
    },
    async signHandoffMachine(value: Handoff.MachinePlan): Promise<Handoff.SignedMachinePlan> {
      const plan = Handoff.MachinePlan.parse(value)
      if (
        plan.orgID !== identity.orgID ||
        plan.deploymentIncarnation !== identity.deploymentIncarnation ||
        plan.keyID !== identity.keyID ||
        plan.issuedAt > Date.now() ||
        plan.expiresAt <= Date.now()
      )
        fail("PERMISSION_DENIED", "Handoff machine plan belongs to another or expired signing authority")
      return { plan, signature: await Handoff.signMachinePlan(plan, privateKey) }
    },
    async signInteractions(value: Interactions.Permit): Promise<Interactions.SignedPermit> {
      const permit = Interactions.Permit.parse(value)
      if (
        permit.orgID !== identity.orgID ||
        permit.deploymentIncarnation !== identity.deploymentIncarnation ||
        permit.keyID !== identity.keyID ||
        permit.issuedAt > Date.now() ||
        permit.expiresAt <= Date.now()
      )
        fail("PERMISSION_DENIED", "Interaction read belongs to another or expired signing authority")
      return { permit, signature: await Interactions.sign(permit, privateKey) }
    },
    async signRead(value: Read.Permit): Promise<Read.SignedPermit> {
      const permit = Read.Permit.parse(value)
      if (
        permit.orgID !== identity.orgID ||
        permit.deploymentIncarnation !== identity.deploymentIncarnation ||
        permit.keyID !== identity.keyID ||
        permit.issuedAt > Date.now() ||
        permit.expiresAt <= Date.now()
      )
        fail("PERMISSION_DENIED", "Private read belongs to another or expired signing authority")
      return { permit, signature: await Read.sign(permit, privateKey) }
    },
    async signHandoff(value: Handoff.Permit): Promise<Handoff.SignedPermit> {
      const permit = Handoff.Permit.parse(value)
      if (
        permit.orgID !== identity.orgID ||
        permit.deploymentIncarnation !== identity.deploymentIncarnation ||
        permit.keyID !== identity.keyID
      )
        fail("PERMISSION_DENIED", "Handoff permit belongs to another signing authority")
      return { permit, signature: await Handoff.signPermit(permit, privateKey) }
    },
    async signGateway(value: Gateway.Permit): Promise<Gateway.SignedPermit> {
      const permit = Gateway.Permit.parse(value)
      if (
        permit.orgID !== identity.orgID ||
        permit.deploymentIncarnation !== identity.deploymentIncarnation ||
        permit.keyID !== identity.keyID
      )
        fail("PERMISSION_DENIED", "Gateway permit belongs to another signing authority")
      if (permit.issuedAt > Date.now() || permit.expiresAt <= Date.now())
        fail("PERMISSION_DENIED", "Gateway permit is outside its signing window")
      return { permit, signature: await Gateway.signPermit(permit, privateKey) }
    },
    async sign(value: Command.Permit): Promise<Command.SignedPermit> {
      const permit = Command.Permit.parse(value)
      if (
        permit.orgID !== identity.orgID ||
        permit.deploymentIncarnation !== identity.deploymentIncarnation ||
        permit.keyID !== identity.keyID
      )
        fail("PERMISSION_DENIED", "Command permit belongs to another signing authority")
      if (permit.authorizedAt > Date.now() || permit.deadline <= Date.now())
        fail("PERMISSION_DENIED", "Command permit is outside its signing window")
      return { permit, signature: await Command.sign(permit, privateKey) }
    },
    async signSkip(value: Command.SkipPermit): Promise<Command.SignedSkip> {
      const permit = Command.SkipPermit.parse(value)
      if (
        permit.command.orgID !== identity.orgID ||
        permit.command.deploymentIncarnation !== identity.deploymentIncarnation ||
        permit.command.keyID !== identity.keyID
      )
        fail("PERMISSION_DENIED", "Command skip belongs to another signing authority")
      if (permit.authorizedAt > Date.now() || permit.deadline <= Date.now())
        fail("PERMISSION_DENIED", "Command skip is outside its signing window")
      return { permit, signature: await Command.signSkip(permit, privateKey) }
    },
  }
}
export type CommandSigningAuthority = Awaited<ReturnType<typeof loadSigningAuthority>>
