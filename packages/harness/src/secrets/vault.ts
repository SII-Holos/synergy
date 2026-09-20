import { RuntimeContext } from "../lifecycle/context"
import { createHash } from "crypto"
import fs from "fs/promises"
import { authLockDirectory, withFileLock } from "@ericsanchezok/synergy-util/fs-lock"
import { Global } from "../global"
import { Log } from "../util/log"
import { readFileWithRetry } from "../util/io-retry"
import { SecretPaths } from "./path-registry"

const log = Log.create({ service: "secrets" })

const SCHEMA_VERSION = 1
const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz"
const ID_LENGTH = 12
const MAX_RESOLVE_HISTORY = 200

export namespace SecretVault {
  export class NotFoundError extends Error {
    constructor() {
      super("Secret does not exist")
    }
  }

  export class ConflictError extends Error {
    constructor() {
      super("Secret value or identifier is already registered")
    }
  }

  export type Source =
    | { kind: "user" }
    | { kind: "config"; path?: string }
    | { kind: "reference"; type: "env"; var: string }
    | { kind: "reference"; type: "file"; path: string }
    | { kind: "heuristic"; context: "user_message" | "tool_output" | "credential_file" }

  export interface Policy {
    /** Tool ids allowed to resolve this key; absent means every tool. */
    tools?: string[]
    /** Maximum resolves per session; absent means unlimited. */
    maxResolvesPerSession?: number
  }

  export interface Fingerprint {
    sha256: string
    length: number
  }

  interface AuditEntry {
    at: number
    sessionID?: string
    tool?: string
    outcome: "resolved" | "denied_policy" | "denied_limit" | "removed"
  }

  interface InternalEntry {
    id: string
    value: string
    fingerprint: Fingerprint
    source: Source
    policy?: Policy
    createdAt: number
    updatedAt: number
    lastResolvedAt?: number
    resolvedCount: number
    history: AuditEntry[]
  }

  /** Panel/API view: every durable field except the secret value itself. */
  export type Entry = Omit<InternalEntry, "value">

  interface Store {
    schemaVersion: number
    entries: Record<string, InternalEntry>
  }

  function filepath() {
    return Global.Path.secretVault
  }

  function fingerprintOf(value: string): Fingerprint {
    return { sha256: createHash("sha256").update(value).digest("hex"), length: value.length }
  }

  function crockfordBytes(hex: string, bytes: number): string {
    let out = ""
    for (let i = 0; i < bytes; i++) {
      const byte = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
      out += CROCKFORD[byte >> 4] + CROCKFORD[byte & 0xf]
    }
    return out
  }

  /** Id is a pure function of the value: same value, same id, always. */
  function deriveId(value: string): string {
    const hex = createHash("sha256").update(value).digest("hex")
    return crockfordBytes(hex, ID_LENGTH / 2)
  }

  /** Public id derivation for callers that pre-check existence. */
  export function idOf(value: string): string {
    return deriveId(value)
  }

  export async function has(id: string): Promise<boolean> {
    const store = await readStore()
    return store.entries[id] !== undefined
  }

  function emptyStore(): Store {
    return { schemaVersion: SCHEMA_VERSION, entries: {} }
  }

  async function readStore(): Promise<Store> {
    let raw: string
    try {
      raw = await readFileWithRetry(filepath())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyStore()
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = undefined
    }
    const store = parsed as Store | undefined
    if (!store || typeof store !== "object" || Array.isArray(store) || store.schemaVersion !== SCHEMA_VERSION) {
      const quarantine = `${filepath()}.corrupt-${Date.now()}`
      await fs.rename(filepath(), quarantine).catch(() => {})
      log.warn("secret vault store was unreadable; quarantined and starting fresh", { quarantine })
      return emptyStore()
    }
    if (!store.entries || typeof store.entries !== "object") store.entries = {}
    return store
  }

  async function writeStore(store: Store) {
    const filename = filepath()
    await fs.mkdir(Global.Path.auth, { recursive: true })
    const tmp = `${filename}.${process.pid}.${Date.now()}.tmp`
    const handle = await fs.open(tmp, "wx", 0o600)
    try {
      await handle.writeFile(JSON.stringify(store, null, 2))
    } finally {
      await handle.close()
    }
    await fs.rename(tmp, filename)
  }

  const runtimeState = RuntimeContext.state(() => ({
    locks: new Map<string, Promise<unknown>>(),
  }))

  async function mutate<T>(fn: (store: Store) => Promise<T> | T): Promise<T> {
    const instanceState = runtimeState()

    const previous = instanceState.locks.get("secret-vault") ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const next = previous.catch(() => {}).then(() => current)
    instanceState.locks.set("secret-vault", next)
    await previous.catch(() => {})
    try {
      return await withFileLock(
        {
          directory: authLockDirectory(Global.Path.root),
          key: "secret-vault-store",
          timeoutMessage: "Timed out acquiring secret vault lock",
        },
        async () => {
          const store = await readStore()
          const result = await fn(store)
          await writeStore(store)
          return result
        },
      )
    } finally {
      release()
      if (instanceState.locks.get("secret-vault") === next) instanceState.locks.delete("secret-vault")
    }
  }

  function toEntry(entry: InternalEntry): Entry {
    const { value: _value, ...rest } = entry
    return rest
  }

  export interface RegisterInput {
    policy?: Policy
  }

  function registerInStore(store: Store, value: string, source: Source, input?: RegisterInput): InternalEntry {
    const id = deriveId(value)
    const existing = store.entries[id]
    if (existing) {
      if (existing.fingerprint.sha256 === fingerprintOf(value).sha256) return existing
      throw new ConflictError()
    }
    const now = Date.now()
    const entry: InternalEntry = {
      id,
      value,
      fingerprint: fingerprintOf(value),
      source,
      ...(input?.policy ? { policy: input.policy } : {}),
      createdAt: now,
      updatedAt: now,
      resolvedCount: 0,
      history: [],
    }
    store.entries[id] = entry
    log.info("secret registered", { id, kind: source.kind })
    return entry
  }

  export async function register(value: string, source: Source, input?: RegisterInput): Promise<InternalEntry> {
    if (!value) throw new Error("cannot register an empty secret")
    return mutate((store) => registerInStore(store, value, source, input))
  }

  /** One snapshot for known values; one locked batch for new values. */
  export async function registerMany(values: string[], source: Source): Promise<MaskIndexItem[]> {
    const unique = [...new Set(values)]
    if (unique.some((value) => !value)) throw new Error("cannot register an empty secret")
    const store = await readStore()
    if (unique.every((value) => store.entries[deriveId(value)]?.fingerprint.sha256 === fingerprintOf(value).sha256)) {
      return indexOf(store)
    }
    return mutate((current) => {
      for (const value of unique) registerInStore(current, value, source)
      return indexOf(current)
    })
  }

  export async function get(id: string): Promise<Entry | undefined> {
    const store = await readStore()
    const entry = store.entries[id]
    return entry ? toEntry(entry) : undefined
  }

  export async function list(): Promise<Entry[]> {
    const store = await readStore()
    return Object.values(store.entries)
      .map(toEntry)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  /** Panel-only, audit-adjacent: returns the plaintext value for one key. */
  export async function reveal(id: string): Promise<string | undefined> {
    const store = await readStore()
    return store.entries[id]?.value
  }

  export async function updatePolicy(id: string, policy: Policy): Promise<Entry | undefined> {
    return mutate((store) => {
      const entry = store.entries[id]
      if (!entry) return undefined
      entry.policy = Object.keys(policy).length > 0 ? policy : undefined
      entry.updatedAt = Date.now()
      return toEntry(entry)
    })
  }

  /** Replace the value; the entry keeps policy and history under the new id. */
  export async function rotate(id: string, nextValue: string): Promise<InternalEntry> {
    if (!nextValue) throw new Error("cannot rotate to an empty secret")
    const nextId = deriveId(nextValue)
    return mutate((store) => {
      const entry = store.entries[id]
      if (!entry) throw new NotFoundError()
      if ((nextId !== id && store.entries[nextId]) || (nextId === id && entry.value !== nextValue))
        throw new ConflictError()
      if (nextId !== id) delete store.entries[id]
      entry.id = nextId
      entry.value = nextValue
      entry.fingerprint = fingerprintOf(nextValue)
      entry.updatedAt = Date.now()
      store.entries[nextId] = entry
      return entry
    })
  }

  export async function remove(id: string): Promise<boolean> {
    return mutate((store) => {
      const entry = store.entries[id]
      if (!entry) return false
      delete store.entries[id]
      entry.history.push({ at: Date.now(), outcome: "removed" })
      log.info("secret removed; historical tokens no longer resolve", { id })
      return true
    })
  }

  export interface ResolveInput {
    sessionID?: string
    tool?: string
  }

  export type ResolveResult = { value: string } | { denied: true; reason: "policy" | "limit" | "missing" }

  export async function resolve(id: string, input: ResolveInput): Promise<ResolveResult> {
    return mutate((store) => {
      const entry = store.entries[id]
      const audit: AuditEntry = {
        at: Date.now(),
        ...(input.sessionID ? { sessionID: input.sessionID } : {}),
        ...(input.tool ? { tool: input.tool } : {}),
        outcome: "resolved",
      }
      if (!entry) return { denied: true, reason: "missing" as const }
      if (entry.policy?.tools?.length && (!input.tool || !entry.policy.tools.includes(input.tool))) {
        audit.outcome = "denied_policy"
        pushAudit(entry, audit)
        return { denied: true, reason: "policy" as const }
      }
      if (entry.policy?.maxResolvesPerSession !== undefined && input.sessionID) {
        const used = entry.history.filter(
          (item) => item.outcome === "resolved" && item.sessionID === input.sessionID,
        ).length
        if (used >= entry.policy.maxResolvesPerSession) {
          audit.outcome = "denied_limit"
          pushAudit(entry, audit)
          return { denied: true, reason: "limit" as const }
        }
      }
      entry.resolvedCount++
      entry.lastResolvedAt = Date.now()
      pushAudit(entry, audit)
      return { value: entry.value }
    })
  }

  function pushAudit(entry: InternalEntry, audit: AuditEntry) {
    entry.history.push(audit)
    if (entry.history.length > MAX_RESOLVE_HISTORY) {
      entry.history.splice(0, entry.history.length - MAX_RESOLVE_HISTORY)
    }
  }

  export async function resolveHistory(id: string): Promise<AuditEntry[]> {
    const store = await readStore()
    return store.entries[id]?.history ?? []
  }

  /**
   * Register every secret-shaped config value. Called on config load and on
   * `Config.Event.Updated`; idempotent by derived id, so reloads are no-ops
   * for unchanged values.
   */
  export async function syncFromConfig(config: Record<string, unknown>): Promise<InternalEntry[]> {
    const collected = SecretPaths.collectSecretValues(config)
    const registered: InternalEntry[] = []
    const store = await readStore()
    for (const item of collected) {
      const id = deriveId(item.value)
      if (store.entries[id]) continue
      registered.push(await register(item.value, { kind: "config", path: item.path.join(".") }))
    }
    return registered
  }

  export interface MaskIndexItem {
    id: string
    value: string
  }

  /**
   * Snapshot of registered values for the masking engine. Value-preserving
   * masking means an unregistered lookalike simply never matches.
   */
  export async function maskIndex(): Promise<MaskIndexItem[]> {
    const store = await readStore()
    return indexOf(store)
  }

  function indexOf(store: Store): MaskIndexItem[] {
    return Object.values(store.entries)
      .map((entry) => ({ id: entry.id, value: entry.value }))
      .sort((a, b) => b.value.length - a.value.length || a.id.localeCompare(b.id))
  }

  /** Cheap emptiness check for callers that skip work when the vault is unused. */
  export async function hasAny(): Promise<boolean> {
    const store = await readStore()
    return Object.keys(store.entries).length > 0
  }

  export const test = {
    deriveId,
    fingerprintOf,
  }
}
