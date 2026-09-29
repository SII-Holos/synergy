import { createHash, randomUUID } from "node:crypto"
import { z } from "zod"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import {
  BrowserProfileSchema,
  BrowserProfileCreateSchema,
  BrowserProfileUpdateSchema,
  BrowserOriginPolicySchema,
  BrowserProtocolError,
  browserOrigin,
  type BrowserProfile,
  type BrowserOriginPolicy,
} from "@ericsanchezok/synergy-browser-core"

const StoredProfile = BrowserProfileSchema.extend({ partition: z.string().min(1).max(250) })
const Catalog = z
  .object({
    version: z.literal(1),
    storeId: z.string(),
    defaultProfileId: z.string().nullable(),
    profiles: z.array(StoredProfile),
  })
  .strict()
const catalogKey = ["browser", "profiles-v1"]
const state = RuntimeContext.state(() => ({
  tail: Promise.resolve(),
  temporary: new Map<string, z.infer<typeof StoredProfile>>(),
  listeners: new Set<(id: string) => Promise<void>>(),
}))

export namespace BrowserProfiles {
  export type Stored = z.infer<typeof StoredProfile>

  async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const current = state()
    const operation = current.tail.then(fn)
    current.tail = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  async function catalog(): Promise<z.infer<typeof Catalog>> {
    const [raw] = await Storage.readMany([catalogKey])
    if (raw !== undefined) return Catalog.parse(raw)
    const storeId = randomUUID()
    const personal = make("personal", "Personal", "persistent", storeId)
    const value: z.infer<typeof Catalog> = { version: 1, storeId, defaultProfileId: personal.id, profiles: [personal] }
    await Storage.write(catalogKey, value)
    return value
  }

  function make(id: string, name: string, kind: Stored["kind"], storeId: string): Stored {
    return {
      id,
      name,
      kind,
      enabled: true,
      revision: 0,
      createdAt: Date.now(),
      origins: {},
      partition: `${kind === "persistent" ? "persist:" : ""}synergy-browser-${storeId}-${id}`,
    }
  }

  export function publicProfile(profile: Stored): BrowserProfile {
    const { partition: _, ...publicValue } = profile
    return publicValue
  }

  export function list() {
    return exclusive(async () => {
      const value = await catalog()
      return { defaultProfileId: value.defaultProfileId, profiles: value.profiles.map(publicProfile) }
    })
  }

  export function defaultProfile(): Promise<Stored> {
    return exclusive(async () => {
      const value = await catalog()
      const profile = value.profiles.find((profile) => profile.id === value.defaultProfileId && profile.enabled)
      if (!profile)
        throw new BrowserProtocolError({
          code: "browser_profile_unavailable",
          message: "Choose an enabled browser identity.",
          retryable: false,
        })
      return structuredClone(profile)
    })
  }

  export function get(id: string): Promise<Stored> {
    return exclusive(async () => {
      const profile = state().temporary.get(id) ?? (await catalog()).profiles.find((profile) => profile.id === id)
      if (!profile) throw missing(id)
      return structuredClone(profile)
    })
  }

  export async function requireEnabled(id: string): Promise<Stored> {
    const profile = await get(id)
    if (!profile.enabled)
      throw new BrowserProtocolError({
        code: "browser_profile_disabled",
        message: `Browser identity ${profile.name} is disabled. Choose another identity.`,
        retryable: false,
      })
    return profile
  }

  export function create(input: z.infer<typeof BrowserProfileCreateSchema>): Promise<Stored> {
    const parsed = BrowserProfileCreateSchema.parse(input)
    return exclusive(async () => {
      const value = await catalog()
      const profile = make(randomUUID(), parsed.name, parsed.kind ?? "persistent", value.storeId)
      if (profile.kind === "temporary") state().temporary.set(profile.id, profile)
      else {
        value.profiles.push(profile)
        value.defaultProfileId ??= profile.id
        await Storage.write(catalogKey, value)
      }
      return structuredClone(profile)
    })
  }

  export async function update(id: string, input: z.infer<typeof BrowserProfileUpdateSchema>): Promise<Stored> {
    const parsed = BrowserProfileUpdateSchema.parse(input)
    const result = await exclusive(async () => {
      const value = await catalog()
      const profile = value.profiles.find((item) => item.id === id)
      if (!profile) throw missing(id)
      Object.assign(profile, parsed, { revision: profile.revision + 1 })
      if (!profile.enabled && value.defaultProfileId === id)
        value.defaultProfileId = value.profiles.find((item) => item.enabled)?.id ?? null
      await Storage.write(catalogKey, value)
      return profile
    })
    await changed(id)
    return result
  }

  export async function setDefault(id: string): Promise<void> {
    await exclusive(async () => {
      const value = await catalog()
      const profile = value.profiles.find((item) => item.id === id)
      if (!profile?.enabled) throw new Error("Choose an enabled persistent identity.")
      value.defaultProfileId = id
      await Storage.write(catalogKey, value)
    })
  }

  export async function setPolicy(id: string, origin: string, policy: BrowserOriginPolicy | null): Promise<void> {
    const key = browserOrigin(origin)
    const parsed = policy === null ? null : BrowserOriginPolicySchema.parse(policy)
    await exclusive(async () => {
      const value = await catalog()
      const profile = value.profiles.find((item) => item.id === id)
      if (!profile) throw missing(id)
      if (parsed) profile.origins[key] = parsed
      else delete profile.origins[key]
      profile.revision++
      await Storage.write(catalogKey, value)
    })
    await changed(id)
  }

  export async function remove(id: string): Promise<void> {
    await update(id, { enabled: false })
    await exclusive(async () => {
      const value = await catalog()
      value.profiles = value.profiles.filter((profile) => profile.id !== id)
      await Storage.write(catalogKey, value)
    })
  }

  export function releaseTemporary(id: string): void {
    state().temporary.delete(id)
  }

  export function onChange(listener: (id: string) => Promise<void>): () => void {
    state().listeners.add(listener)
    return () => state().listeners.delete(listener)
  }

  async function changed(id: string): Promise<void> {
    const results = await Promise.allSettled([...state().listeners].map((listener) => listener(id)))
    const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
    if (errors.length) throw new AggregateError(errors, "Identity updated; some active pages still need cleanup.")
  }

  export function legacy(ownerKey: string): Promise<Stored> {
    return legacyDigest(createHash("sha256").update(ownerKey).digest("hex"))
  }

  export function legacyDigest(digest: string): Promise<Stored> {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid legacy identity")
    return exclusive(async () => {
      const value = await catalog()
      const id = `legacy-${digest}`
      const existing = value.profiles.find((profile) => profile.id === id)
      if (existing) return existing
      const profile = {
        ...make(id, `Imported identity ${value.profiles.length}`, "persistent", value.storeId),
        partition: `persist:synergy-browser-${digest}`,
      }
      value.profiles.push(profile)
      await Storage.write(catalogKey, value)
      return profile
    })
  }
}

function missing(id: string) {
  return new BrowserProtocolError({
    code: "browser_profile_missing",
    message: `Browser identity ${id} was not found. Choose an available identity.`,
    retryable: false,
  })
}
