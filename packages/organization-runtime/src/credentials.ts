import { createPrivateKey, createPublicKey } from "node:crypto"
import path from "node:path"
import { z } from "zod"
import { OrganizationRuntimeProtocol as Protocol } from "@ericsanchezok/synergy-organization-protocol"
import { MemberHomeError, readRecordSnapshot, parseRecord, writeRecord } from "./record.js"

const Credentials = z.strictObject({
  schemaVersion: z.literal(1),
  publicKey: Protocol.PublicKey,
  pkcs8: z.string().regex(/^(?:[a-f0-9]{2}){1,1024}$/),
})

function filename(root: string) {
  return path.join(root, "auth", "organization-runtime.json")
}

export async function createCredentials(root: string) {
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const publicKey = await Protocol.publicKey(keys.publicKey)
  await writeRecord(filename(root), {
    schemaVersion: 1,
    publicKey,
    pkcs8: Buffer.from(await crypto.subtle.exportKey("pkcs8", keys.privateKey)).toString("hex"),
  })
  return { publicKey, privateKey: keys.privateKey }
}

export async function readCredentials(root: string) {
  const stored = await readRecordSnapshot(filename(root), Credentials, "credentials")
  return stored ? decode(stored.value) : undefined
}

export function verifyCredentialRecord(bytes: Uint8Array) {
  return decode(parseRecord(bytes, Credentials, "credentials"))
}

export async function captureCredentialRecord(root: string, options: { signal?: AbortSignal } = {}) {
  const stored = await readRecordSnapshot(filename(root), Credentials, "credentials", options)
  if (!stored) throw new MemberHomeError("Member Runtime credentials are missing")
  const verified = await decode(stored.value)
  options.signal?.throwIfAborted()
  return { bytes: stored.bytes, publicKey: verified.publicKey }
}

async function decode(stored: z.infer<typeof Credentials>) {
  try {
    const bytes = Buffer.from(stored.pkcs8, "hex")
    const key = createPrivateKey({ key: bytes, type: "pkcs8", format: "der" })
    if (key.asymmetricKeyType !== "ed25519") throw new Error("Wrong key algorithm")
    const publicKey = createPublicKey(key).export({ format: "jwk" }).x
    if (!publicKey || Buffer.from(publicKey, "base64url").toString("hex") !== stored.publicKey)
      throw new Error("Mismatched key pair")
    return {
      publicKey: stored.publicKey,
      privateKey: await crypto.subtle.importKey("pkcs8", bytes, "Ed25519", false, ["sign"]),
    }
  } catch {
    throw new MemberHomeError("Member Runtime credentials are invalid or unsupported")
  }
}
