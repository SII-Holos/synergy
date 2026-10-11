import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto"
import { z } from "zod"
import { Storage } from "../storage/storage"
import { StorageQueue } from "../storage/queue"
import { NotFoundError, StorageConflictError, StorageIntegrityError } from "../storage/errors"
import type { SecretVault } from "./vault"

export interface VaultKeyProvider {
  current(): Promise<{ version: string; key: Uint8Array }>
  resolve(version: string): Promise<Uint8Array>
}

const key = ["secrets", "encrypted-vault"]
const Version = z.string().min(1).max(128)
const Ciphertext = z
  .object({
    keyVersion: Version,
    nonce: z.string().base64(),
    tag: z.string().base64(),
    content: z.string().base64(),
  })
  .strict()
const Envelope = z.object({ version: z.literal(1), entries: z.record(z.string(), Ciphertext) }).strict()
type Envelope = z.infer<typeof Envelope>

/** Keys come from an external authority; only authenticated ciphertext enters SQL. */
export function encryptedSecretVault(options: {
  authority: readonly string[]
  keys: VaultKeyProvider
}): SecretVault.Persistence {
  if (!options.authority.length || options.authority.some((part) => !part || part.length > 1024))
    throw new Error("Encrypted vault requires a stable authority")
  const authority = [...options.authority]
  const gate = new StorageQueue("secret-vault.encrypted")
  const aad = (id: string, version: string) =>
    Buffer.from(JSON.stringify(["synergy-secret-v1", ...authority, id, version]))
  const importKey = (value: Uint8Array) => {
    if (value.length !== 32) throw new StorageIntegrityError("Vault encryption requires a 256-bit key")
    return Buffer.from(value)
  }

  const load = async () => {
    if (Storage.inTransaction()) throw new StorageConflictError("Resolve vault keys outside business transactions")
    const row = await Storage.versioned(key).catch((error) => {
      if (error instanceof NotFoundError) return undefined
      throw error
    })
    const envelope = row ? Envelope.parse(row.value) : { version: 1 as const, entries: {} }
    const entries: SecretVault.Store["entries"] = {}
    const keys = new Map<string, Buffer>()
    try {
      for (const [id, encrypted] of Object.entries(envelope.entries)) {
        let secretKey = keys.get(encrypted.keyVersion)
        if (!secretKey) {
          secretKey = importKey(await options.keys.resolve(encrypted.keyVersion))
          keys.set(encrypted.keyVersion, secretKey)
        }
        const nonce = Buffer.from(encrypted.nonce, "base64")
        const tag = Buffer.from(encrypted.tag, "base64")
        if (nonce.length !== 12 || tag.length !== 16)
          throw new StorageIntegrityError("Invalid vault encryption envelope")
        let bytes: Buffer
        try {
          const decipher = createDecipheriv("aes-256-gcm", secretKey, nonce)
          decipher.setAAD(aad(id, encrypted.keyVersion))
          decipher.setAuthTag(tag)
          bytes = Buffer.concat([decipher.update(Buffer.from(encrypted.content, "base64")), decipher.final()])
        } catch {
          throw new StorageIntegrityError("Secret vault authentication failed")
        }
        try {
          const entry = JSON.parse(bytes.toString("utf8")) as SecretVault.Store["entries"][string]
          if (
            !entry ||
            entry.id !== id ||
            typeof entry.value !== "string" ||
            entry.fingerprint?.sha256 !== createHash("sha256").update(entry.value).digest("hex")
          )
            throw new StorageIntegrityError("Invalid decrypted secret entry")
          entries[id] = entry
        } finally {
          bytes.fill(0)
        }
      }
      return { store: { schemaVersion: 1, entries }, revision: row?.revision ?? 0n }
    } finally {
      for (const value of keys.values()) value.fill(0)
    }
  }

  return {
    async read() {
      return (await load()).store
    },
    async mutate(change) {
      return gate.run(async () => {
        const { store, revision } = await load()
        const current = await options.keys.current()
        const version = Version.parse(current.version)
        const secretKey = importKey(current.key)
        try {
          const result = await change(store)
          const envelope: Envelope = { version: 1, entries: {} }
          for (const [id, entry] of Object.entries(store.entries)) {
            const nonce = randomBytes(12)
            const cipher = createCipheriv("aes-256-gcm", secretKey, nonce)
            cipher.setAAD(aad(id, version))
            const bytes = Buffer.from(JSON.stringify(entry))
            try {
              const content = Buffer.concat([cipher.update(bytes), cipher.final()])
              envelope.entries[id] = {
                keyVersion: version,
                nonce: nonce.toString("base64"),
                tag: cipher.getAuthTag().toString("base64"),
                content: content.toString("base64"),
              }
            } finally {
              bytes.fill(0)
            }
          }
          const requestHash = createHash("sha256").update(JSON.stringify(envelope)).digest("hex")
          // The receipt must never serialize the callback's potentially secret result.
          await Storage.transaction(
            async (tx) => {
              await tx.write(key, envelope, { expectedRevision: revision })
            },
            { operationID: `secret-vault:${randomUUID()}`, requestHash },
          )
          return result
        } finally {
          secretKey.fill(0)
        }
      })
    },
  }
}
