import { Global } from "../global"
import fs from "fs/promises"
import z from "zod"

export namespace Auth {
  export const Oauth = z
    .object({
      type: z.literal("oauth"),
      refresh: z.string(),
      access: z.string(),
      expires: z.number(),
      enterpriseUrl: z.string().optional(),
      metadata: z.record(z.string(), z.any()).optional(),
    })
    .meta({ ref: "OAuth" })

  export const Api = z
    .object({
      type: z.literal("api"),
      key: z.string(),
      metadata: z.record(z.string(), z.any()).optional(),
    })
    .meta({ ref: "ApiAuth" })

  export const WellKnown = z
    .object({
      type: z.literal("wellknown"),
      key: z.string(),
      token: z.string(),
      metadata: z.record(z.string(), z.any()).optional(),
    })
    .meta({ ref: "WellKnownAuth" })

  export const Holos = z
    .object({
      type: z.literal("holos"),
      agentId: z.string(),
      agentSecret: z.string(),
      metadata: z.record(z.string(), z.any()).optional(),
    })
    .meta({ ref: "HolosAuth" })

  export const Info = z.discriminatedUnion("type", [Oauth, Api, WellKnown, Holos]).meta({ ref: "Auth" })
  export type Info = z.infer<typeof Info>

  export const PoolEntry = z
    .object({
      id: z.string(),
      status: z.enum(["active", "exhausted", "dead"]),
      auth: Info,
      cooldownUntil: z.number().optional(),
      resetAt: z.number().optional(),
      failureCode: z.string().optional(),
      usageCount: z.number().int().min(0).optional(),
      updatedAt: z.number(),
    })
    .meta({ ref: "ProviderAuthPoolEntry" })
  export type PoolEntry = z.infer<typeof PoolEntry>

  export const StoreEntry = z
    .object({
      providerID: z.string(),
      authKind: z.enum(["api", "oauth", "wellknown", "holos"]),
      auth: Info,
      source: z.enum(["migration", "api", "cli", "web", "env", "import", "plugin"]).optional(),
      updatedAt: z.number(),
      pool: z.array(PoolEntry).optional(),
    })
    .meta({ ref: "ProviderAuthStoreEntry" })
  export type StoreEntry = z.infer<typeof StoreEntry>

  export const Store = z
    .object({
      schemaVersion: z.literal(2),
      credentials: z.record(z.string(), StoreEntry),
    })
    .meta({ ref: "ProviderAuthStore" })
  export type Store = z.infer<typeof Store>

  const locks = new Map<string, Promise<unknown>>()

  function filepath() {
    return Global.Path.authProvider
  }

  export function legacyFilepath() {
    return Global.Path.authApiKey
  }

  async function readStore(): Promise<Store> {
    const file = Bun.file(filepath())
    const raw = await file.json().catch(() => undefined)
    const parsed = Store.safeParse(raw)
    if (parsed.success) return parsed.data
    return {
      schemaVersion: 2,
      credentials: {},
    }
  }

  async function writeStore(store: Store) {
    const file = Bun.file(filepath())
    await fs.mkdir(Global.Path.auth, { recursive: true })
    const tmp = `${file.name}.${process.pid}.${Date.now()}.tmp`
    await Bun.write(tmp, JSON.stringify(store, null, 2))
    await fs.chmod(tmp, 0o600)
    await fs.rename(tmp, file.name!)
  }

  function entryFromInfo(providerID: string, info: Info, source?: StoreEntry["source"]): StoreEntry {
    return {
      providerID,
      authKind: info.type,
      auth: info,
      source,
      updatedAt: Date.now(),
    }
  }

  export async function migrateLegacy(input?: { backup?: boolean }): Promise<{ migrated: boolean; count: number }> {
    const oldFile = Bun.file(legacyFilepath())
    if (!(await oldFile.exists())) return { migrated: false, count: 0 }
    const legacy = await oldFile.json().catch(() => undefined)
    if (!legacy || typeof legacy !== "object" || Array.isArray(legacy)) return { migrated: false, count: 0 }

    const store = await readStore()
    let count = 0
    for (const [providerID, value] of Object.entries(legacy)) {
      if (store.credentials[providerID]) continue
      const parsed = Info.safeParse(value)
      if (!parsed.success) continue
      store.credentials[providerID] = entryFromInfo(providerID, parsed.data, "migration")
      count++
    }
    if (count > 0) await writeStore(store)
    if (input?.backup !== false) {
      const backup = `${legacyFilepath()}.bak`
      await fs.copyFile(legacyFilepath(), backup).catch(() => {})
      await fs.chmod(backup, 0o600).catch(() => {})
    }
    return { migrated: count > 0, count }
  }

  export async function get(providerID: string) {
    const auth = await all()
    return auth[providerID]
  }

  export async function all(): Promise<Record<string, Info>> {
    const data = (await readStore()).credentials
    return Object.entries(data).reduce(
      (acc, [key, value]) => {
        const parsed = StoreEntry.safeParse(value)
        if (!parsed.success) return acc
        acc[key] = parsed.data.auth
        return acc
      },
      {} as Record<string, Info>,
    )
  }

  export async function entries(): Promise<Record<string, StoreEntry>> {
    return (await readStore()).credentials
  }

  export async function set(key: string, info: Info, options?: { source?: StoreEntry["source"] }) {
    const store = await readStore()
    const existingPool = store.credentials[key]?.pool
    store.credentials[key] = {
      ...entryFromInfo(key, info, options?.source),
      pool: existingPool,
    }
    await writeStore(store)
  }

  export async function remove(key: string) {
    const store = await readStore()
    delete store.credentials[key]
    await writeStore(store)
  }

  export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const next = previous.catch(() => {}).then(() => current)
    locks.set(key, next)
    await previous.catch(() => {})
    try {
      return await fn()
    } finally {
      release()
      if (locks.get(key) === next) locks.delete(key)
    }
  }

  export async function markExhausted(
    providerID: string,
    input: { failureCode: string; cooldownUntil?: number; resetAt?: number },
  ) {
    const store = await readStore()
    const entry = store.credentials[providerID]
    if (!entry) return
    const pool = entry.pool ?? [
      {
        id: providerID,
        status: "active" as const,
        auth: entry.auth,
        usageCount: 0,
        updatedAt: Date.now(),
      },
    ]
    entry.pool = pool.map((item, index) =>
      index === 0
        ? {
            ...item,
            status: "exhausted" as const,
            failureCode: input.failureCode,
            cooldownUntil: input.cooldownUntil,
            resetAt: input.resetAt,
            updatedAt: Date.now(),
          }
        : item,
    )
    await writeStore(store)
  }

  export async function markDead(providerID: string, failureCode: string) {
    const store = await readStore()
    const entry = store.credentials[providerID]
    if (!entry) return
    entry.pool = (
      entry.pool ?? [
        {
          id: providerID,
          status: "active" as const,
          auth: entry.auth,
          usageCount: 0,
          updatedAt: Date.now(),
        },
      ]
    ).map((item, index) =>
      index === 0
        ? {
            ...item,
            status: "dead" as const,
            failureCode,
            updatedAt: Date.now(),
          }
        : item,
    )
    await writeStore(store)
  }
}
