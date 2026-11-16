import { z } from "zod"
import { readOrganizationPrivateFile } from "../private-file"
import type { VaultKeyProvider } from "@ericsanchezok/synergy-harness/secrets/encrypted-store"

const KeyVersion = z.string().min(1).max(128)
const KeyFile = z
  .strictObject({
    version: z.literal(1),
    current: KeyVersion,
    keys: z.record(KeyVersion, z.string().regex(/^[A-Za-z0-9+/]{43}=$/)),
  })
  .refine((value) => Object.hasOwn(value.keys, value.current))

export async function withRecoveryKeys<T>(filename: string, body: (keys: VaultKeyProvider) => Promise<T>) {
  const raw = await readOrganizationPrivateFile(filename)
  let selected: z.infer<typeof KeyFile>
  try {
    selected = KeyFile.parse(JSON.parse(raw))
  } catch {
    throw new Error("Read a valid version-one private recovery key file")
  }
  const material = new Map(
    Object.entries(selected.keys).map(([version, value]) => [version, Buffer.from(value, "base64")]),
  )
  try {
    for (const [version, value] of material)
      if (value.byteLength !== 32 || value.toString("base64") !== selected.keys[version])
        throw new Error("Read canonical 32-byte recovery keys")
    const resolve = async (version: string) => {
      const key = material.get(version)
      if (!key) throw new Error("The recovery key file cannot open this key version")
      return key
    }
    return await body({
      current: async () => ({ version: selected.current, key: await resolve(selected.current) }),
      resolve,
    })
  } finally {
    for (const value of material.values()) value.fill(0)
  }
}
