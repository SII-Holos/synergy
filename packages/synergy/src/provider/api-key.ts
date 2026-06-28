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

  export const AuthKind = z.enum(["api_key", "oauth", "wellknown", "holos"])
  export type AuthKind = z.infer<typeof AuthKind>

  export const Tokens = z
    .object({
      apiKey: z.string().optional(),
      accessToken: z.string().optional(),
      refreshToken: z.string().optional(),
      token: z.string().optional(),
      key: z.string().optional(),
      agentId: z.string().optional(),
      agentSecret: z.string().optional(),
    })
    .meta({ ref: "ProviderAuthTokens" })
  export type Tokens = z.infer<typeof Tokens>

  export const Source = z.enum(["migration", "api", "cli", "web", "env", "import", "plugin"])
  export type Source = z.infer<typeof Source>

  export const PoolEntry = z
    .object({
      id: z.string(),
      status: z.enum(["active", "exhausted", "dead"]),
      authKind: AuthKind,
      tokens: Tokens,
      expiresAt: z.number().optional(),
      metadata: z.record(z.string(), z.any()).optional(),
      source: Source.optional(),
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
      authKind: AuthKind,
      tokens: Tokens,
      expiresAt: z.number().optional(),
      metadata: z.record(z.string(), z.any()).optional(),
      source: Source.optional(),
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

  const LegacyStoreEntry = z.object({
    providerID: z.string(),
    authKind: z.enum(["api", "oauth", "wellknown", "holos"]).optional(),
    auth: Info,
    source: Source.optional(),
    updatedAt: z.number(),
    pool: z
      .array(
        z.object({
          id: z.string(),
          status: z.enum(["active", "exhausted", "dead"]),
          auth: Info,
          cooldownUntil: z.number().optional(),
          resetAt: z.number().optional(),
          failureCode: z.string().optional(),
          usageCount: z.number().int().min(0).optional(),
          updatedAt: z.number(),
        }),
      )
      .optional(),
  })

  const locks = new Map<string, Promise<unknown>>()

  function filepath() {
    return Global.Path.authProvider
  }

  export function legacyFilepath() {
    return Global.Path.authApiKey
  }

  function nowSeconds() {
    return Math.floor(Date.now() / 1000)
  }

  function authKindFromInfo(info: Info): AuthKind {
    if (info.type === "api") return "api_key"
    return info.type
  }

  function tokensFromInfo(info: Info): Tokens {
    switch (info.type) {
      case "api":
        return { apiKey: info.key }
      case "oauth":
        return {
          accessToken: info.access,
          refreshToken: info.refresh,
        }
      case "wellknown":
        return {
          key: info.key,
          token: info.token,
        }
      case "holos":
        return {
          agentId: info.agentId,
          agentSecret: info.agentSecret,
        }
    }
  }

  export function infoFromEntry(entry: StoreEntry | PoolEntry): Info | undefined {
    switch (entry.authKind) {
      case "api_key": {
        const key = entry.tokens.apiKey ?? entry.tokens.key
        return key ? { type: "api", key, metadata: entry.metadata } : undefined
      }
      case "oauth": {
        if (!entry.tokens.accessToken || !entry.tokens.refreshToken) return undefined
        return {
          type: "oauth",
          access: entry.tokens.accessToken,
          refresh: entry.tokens.refreshToken,
          expires: entry.expiresAt ?? 0,
          enterpriseUrl: entry.metadata?.enterpriseUrl,
          metadata: entry.metadata,
        }
      }
      case "wellknown": {
        if (!entry.tokens.key || !entry.tokens.token) return undefined
        return {
          type: "wellknown",
          key: entry.tokens.key,
          token: entry.tokens.token,
          metadata: entry.metadata,
        }
      }
      case "holos": {
        if (!entry.tokens.agentId || !entry.tokens.agentSecret) return undefined
        return {
          type: "holos",
          agentId: entry.tokens.agentId,
          agentSecret: entry.tokens.agentSecret,
          metadata: entry.metadata,
        }
      }
    }
  }

  function entryFromInfo(providerID: string, info: Info, source?: Source): StoreEntry {
    return {
      providerID,
      authKind: authKindFromInfo(info),
      tokens: tokensFromInfo(info),
      expiresAt: info.type === "oauth" ? info.expires : undefined,
      metadata: info.metadata,
      source,
      updatedAt: Date.now(),
    }
  }

  function poolEntryFromInfo(id: string, info: Info, source?: Source): PoolEntry {
    const entry = entryFromInfo(id, info, source)
    return {
      id,
      status: "active",
      authKind: entry.authKind,
      tokens: entry.tokens,
      expiresAt: entry.expiresAt,
      metadata: entry.metadata,
      source: entry.source,
      usageCount: 0,
      updatedAt: entry.updatedAt,
    }
  }

  function normalizeEntry(providerID: string, value: unknown): StoreEntry | undefined {
    const current = StoreEntry.safeParse(value)
    if (current.success) return { ...current.data, providerID }

    const legacy = LegacyStoreEntry.safeParse(value)
    if (legacy.success) {
      const entry = entryFromInfo(providerID, legacy.data.auth, legacy.data.source)
      return {
        ...entry,
        updatedAt: legacy.data.updatedAt,
        pool: legacy.data.pool?.map((item) => ({
          ...poolEntryFromInfo(item.id, item.auth, legacy.data.source),
          status: item.status,
          cooldownUntil: item.cooldownUntil,
          resetAt: item.resetAt,
          failureCode: item.failureCode,
          usageCount: item.usageCount,
          updatedAt: item.updatedAt,
        })),
      }
    }

    const info = Info.safeParse(value)
    if (info.success) return entryFromInfo(providerID, info.data, "migration")
    return undefined
  }

  async function readStore(): Promise<Store> {
    const file = Bun.file(filepath())
    const raw = await file.json().catch(() => undefined)
    const rawCredentials = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as any).credentials : undefined
    const credentials: Record<string, StoreEntry> = {}
    if (rawCredentials && typeof rawCredentials === "object" && !Array.isArray(rawCredentials)) {
      for (const [providerID, value] of Object.entries(rawCredentials)) {
        const normalized = normalizeEntry(providerID, value)
        if (normalized) credentials[providerID] = normalized
      }
    }
    return {
      schemaVersion: 2,
      credentials,
    }
  }

  async function writeStore(store: Store) {
    const filename = filepath()
    await fs.mkdir(Global.Path.auth, { recursive: true })
    const tmp = `${filename}.${process.pid}.${Date.now()}.tmp`
    await Bun.write(tmp, JSON.stringify(store, null, 2))
    await fs.chmod(tmp, 0o600)
    await fs.rename(tmp, filename)
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

  function materializePool(entry: StoreEntry): PoolEntry[] {
    if (entry.pool?.length) return entry.pool
    const info = infoFromEntry(entry)
    return info ? [poolEntryFromInfo(entry.providerID, info, entry.source)] : []
  }

  function usablePoolEntry(entry: PoolEntry, now = nowSeconds()) {
    if (entry.status === "dead") return false
    if (entry.status === "active") return true
    const cooldownActive = entry.cooldownUntil !== undefined && entry.cooldownUntil > now
    const resetActive = entry.resetAt !== undefined && entry.resetAt > now
    return !cooldownActive && !resetActive
  }

  function selectPoolEntry(entry: StoreEntry): PoolEntry | undefined {
    const pool = materializePool(entry)
    return pool.find((item) => usablePoolEntry(item))
  }

  export async function select(providerID: string): Promise<
    | {
        providerID: string
        credentialID: string
        auth: Info
        entry: StoreEntry
        poolEntry?: PoolEntry
      }
    | undefined
  > {
    const entry = (await readStore()).credentials[providerID]
    if (!entry) return undefined
    const poolEntry = selectPoolEntry(entry)
    if (entry.pool?.length && !poolEntry) return undefined
    const auth = poolEntry ? infoFromEntry(poolEntry) : infoFromEntry(entry)
    if (!auth) return undefined
    return {
      providerID,
      credentialID: poolEntry?.id ?? providerID,
      auth,
      entry,
      poolEntry,
    }
  }

  export async function get(providerID: string) {
    return (await select(providerID))?.auth
  }

  export async function all(): Promise<Record<string, Info>> {
    const data = (await readStore()).credentials
    const result: Record<string, Info> = {}
    for (const providerID of Object.keys(data)) {
      const selected = await select(providerID)
      if (selected) result[providerID] = selected.auth
    }
    return result
  }

  export async function entries(): Promise<Record<string, StoreEntry>> {
    return (await readStore()).credentials
  }

  export async function set(key: string, info: Info, options?: { source?: Source }) {
    const store = await readStore()
    const primary = poolEntryFromInfo(key, info, options?.source)
    store.credentials[key] = {
      ...entryFromInfo(key, info, options?.source),
      pool: [primary],
    }
    await writeStore(store)
  }

  export async function addToPool(providerID: string, credentialID: string, info: Info, options?: { source?: Source }) {
    const store = await readStore()
    const existing = store.credentials[providerID]
    const next = poolEntryFromInfo(credentialID, info, options?.source)
    if (!existing) {
      store.credentials[providerID] = {
        ...entryFromInfo(providerID, info, options?.source),
        pool: [next],
      }
      await writeStore(store)
      return
    }
    const pool = materializePool(existing).filter((item) => item.id !== credentialID)
    existing.pool = [...pool, next]
    existing.updatedAt = Date.now()
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
    input: { failureCode: string; cooldownUntil?: number; resetAt?: number; credentialID?: string },
  ) {
    const store = await readStore()
    const entry = store.credentials[providerID]
    if (!entry) return
    const selected = input.credentialID ?? selectPoolEntry(entry)?.id
    const pool = materializePool(entry)
    entry.pool = pool.map((item) =>
      item.id === selected
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
    entry.updatedAt = Date.now()
    await writeStore(store)
  }

  export async function markDead(providerID: string, failureCode: string, input?: { credentialID?: string }) {
    const store = await readStore()
    const entry = store.credentials[providerID]
    if (!entry) return
    const selected = input?.credentialID ?? selectPoolEntry(entry)?.id
    const pool = materializePool(entry)
    entry.pool = pool.map((item) =>
      item.id === selected
        ? {
            ...item,
            status: "dead" as const,
            failureCode,
            updatedAt: Date.now(),
          }
        : item,
    )
    entry.updatedAt = Date.now()
    await writeStore(store)
  }
}
