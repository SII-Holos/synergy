import { createPrivateKey, createPublicKey } from "node:crypto"
import { z } from "zod"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import {
  OrganizationCommandProtocol as Command,
  OrganizationProtocol,
  OrganizationRuntimeProtocol as Runtime,
  OrganizationGatewayProtocol as Gateway,
  OrganizationHandoffProtocol as Handoff,
  OrganizationReadProtocol as Read,
} from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationRecord as Record } from "./storage/records"
import { OrganizationStoragePath as Keys } from "./storage/path"
import { fail } from "./error"

async function readSigningIdentity() {
  try {
    return await Record.read(Record.SigningIdentity, Keys.signingIdentity())
  } catch (error) {
    if (error instanceof z.ZodError) throw new Error("Organization signing identity is invalid")
    throw error
  }
}

export async function initializeSigningIdentity() {
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const publicKey = await Runtime.publicKey(keys.publicKey)
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", keys.privateKey)).toString("hex")
  await Storage.transaction(async () => {
    const deployment = OrganizationProtocol.Deployment.parse(await Storage.read(Keys.deployment()))
    const existing = await readSigningIdentity()
    if (existing) {
      if (existing.orgID !== deployment.orgID || existing.deploymentIncarnation !== deployment.deploymentIncarnation)
        throw new Error("Organization signing identity does not match this deployment")
      return
    }
    await Storage.write(
      Keys.signingIdentity(),
      Record.SigningIdentity.parse({
        schemaVersion: 1,
        orgID: deployment.orgID,
        deploymentIncarnation: deployment.deploymentIncarnation,
        keyID: crypto.randomUUID(),
        publicKey,
        pkcs8,
      }),
    )
  })
}

export async function loadSigningAuthority(deployment: OrganizationProtocol.Deployment) {
  const stored = await readSigningIdentity()
  if (!stored || stored.orgID !== deployment.orgID || stored.deploymentIncarnation !== deployment.deploymentIncarnation)
    throw new Error("Organization signing identity is missing or does not match this deployment")
  let privateKey: CryptoKey
  try {
    const bytes = Buffer.from(stored.pkcs8, "hex")
    const key = createPrivateKey({ key: bytes, type: "pkcs8", format: "der" })
    if (key.asymmetricKeyType !== "ed25519") throw new Error("Wrong signing algorithm")
    const publicKey = createPublicKey(key).export({ format: "jwk" }).x
    if (!publicKey || Buffer.from(publicKey, "base64url").toString("hex") !== stored.publicKey)
      throw new Error("Mismatched signing key")
    privateKey = await crypto.subtle.importKey("pkcs8", bytes, "Ed25519", false, ["sign"])
  } catch {
    throw new Error("Organization signing credentials are invalid or unsupported")
  }
  const { pkcs8: _, ...publicFields } = stored
  const identity = Object.freeze(Command.SigningIdentity.parse(publicFields))
  return {
    identity,
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
