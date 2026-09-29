import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import fs from "fs/promises"
import path from "path"
import { Global } from "@ericsanchezok/synergy-harness/global"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"
import type { Migration } from "@ericsanchezok/synergy-harness/migration/types"
import { BrowserOwner } from "./owner.js"
import { BrowserProfiles } from "./profiles.js"
import { BrowserStorage } from "./storage.js"
import {
  BrowserCheckpointSchema,
  BrowserProtocolErrorSchema,
  type BrowserCheckpoint,
  type BrowserProtocolErrorData,
} from "@ericsanchezok/synergy-browser-core"

export namespace BrowserMigration {
  export interface Result {
    ownerKey: string
    changed: boolean
    version: number
  }

  interface StoredState {
    version?: number
    status?: unknown
    page?: unknown
    tabs?: unknown
    activeTabID?: unknown
    panelWidth?: number
    timestamp?: number
    annotations?: unknown[]
    downloads?: unknown[]
    storageStatePath?: string
    profileDir?: string
    checkpoint?: unknown
    error?: unknown
    [key: string]: unknown
  }

  function legacyStateKey(owner: BrowserOwner.Info): string[] {
    const base = ["browser", "sessions", legacyComponent(owner.scopeID, "scope")]
    if (owner.mode === "scope") return [...base, "scope"]
    BrowserOwner.assertValid(owner)
    return [...base, "session", legacyComponent(owner.sessionID!, "session")]
  }

  async function readState(key: string[]): Promise<StoredState | undefined> {
    const [value] = await Storage.readMany<StoredState>([key])
    return value
  }

  function isPage(value: unknown): value is { id: string; url: string; title: string; lastActiveAt?: number | null } {
    if (!value || typeof value !== "object") return false
    const page = value as Record<string, unknown>
    return (
      Boolean(page.id) && typeof page.id === "string" && typeof page.url === "string" && typeof page.title === "string"
    )
  }

  function pageFromState(state: StoredState) {
    const normalize = (page: { id: string; url: string; title: string; lastActiveAt?: number | null }) => ({
      id: normalizePageID(page.id),
      url: (page.url.startsWith("file:") ? "[local file]" : page.url).slice(0, 20_000),
      title: page.title.slice(0, 20_000),
      lastActiveAt: typeof page.lastActiveAt === "number" ? page.lastActiveAt : null,
    })
    if (isPage(state.page)) return normalize(state.page)
    if (!Array.isArray(state.tabs)) return null
    const tabs = state.tabs.filter(isPage)
    if (tabs.length === 0) return null
    if (typeof state.activeTabID === "string") {
      const active = tabs.find((page) => page.id === state.activeTabID)
      if (active) return normalize(active)
    }
    return tabs[0] ? normalize(tabs[0]) : null
  }

  function annotationsFromState(state: StoredState): BrowserStorage.StoredAnnotation[] {
    if (!Array.isArray(state.annotations)) return []
    return state.annotations.slice(0, 10_000).flatMap((value) => {
      if (!value || typeof value !== "object") return []
      const annotation = { ...(value as Record<string, unknown>) }
      if (typeof annotation.pageURL !== "string" && typeof annotation.tabURL === "string") {
        annotation.pageURL = annotation.tabURL
      }
      if (
        typeof annotation.id !== "string" ||
        typeof annotation.pageURL !== "string" ||
        typeof annotation.pageID !== "string" ||
        typeof annotation.comment !== "string" ||
        !annotation.comment ||
        typeof annotation.resolved !== "boolean" ||
        typeof annotation.createdAt !== "number"
      ) {
        return []
      }
      return [
        {
          id: annotation.id.slice(0, 20_000),
          pageURL: annotation.pageURL.slice(0, 20_000),
          pageID: normalizePageID(annotation.pageID),
          ...(typeof annotation.ref === "string" ? { ref: annotation.ref.slice(0, 20_000) } : {}),
          ...(typeof annotation.element === "string" ? { element: annotation.element.slice(0, 100_000) } : {}),
          comment: annotation.comment.slice(0, 20_000),
          ...(annotation.styleFeedback && typeof annotation.styleFeedback === "object"
            ? { styleFeedback: stringRecord(annotation.styleFeedback) }
            : {}),
          resolved: annotation.resolved,
          createdAt: Math.max(0, Math.round(annotation.createdAt)),
        },
      ]
    })
  }

  function normalizePageID(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200) || `page-${crypto.randomUUID()}`
  }

  function checkpointFromState(
    state: StoredState,
    page: ReturnType<typeof pageFromState>,
  ): BrowserCheckpoint | undefined {
    if (!page || page.url.startsWith("[")) return undefined
    const value =
      state.checkpoint && typeof state.checkpoint === "object" ? (state.checkpoint as Record<string, unknown>) : {}
    const viewport =
      value.viewport && typeof value.viewport === "object" ? (value.viewport as Record<string, unknown>) : {}
    const scroll = value.scroll && typeof value.scroll === "object" ? (value.scroll as Record<string, unknown>) : {}
    const checkpoint = {
      url: typeof value.url === "string" ? value.url : page.url,
      cookies: Array.isArray(value.cookies)
        ? value.cookies.filter((cookie): cookie is Record<string, unknown> =>
            Boolean(cookie && typeof cookie === "object"),
          )
        : [],
      origins: Array.isArray(value.origins)
        ? value.origins.flatMap((entry) => {
            if (!entry || typeof entry !== "object") return []
            const origin = entry as Record<string, unknown>
            if (typeof origin.origin !== "string") return []
            return [
              {
                origin: origin.origin,
                localStorage: stringRecord(origin.localStorage),
                sessionStorage: stringRecord(origin.sessionStorage),
              },
            ]
          })
        : [],
      viewport: {
        width: typeof viewport.width === "number" && viewport.width > 0 ? Math.round(viewport.width) : 1280,
        height: typeof viewport.height === "number" && viewport.height > 0 ? Math.round(viewport.height) : 720,
      },
      scroll: {
        x: typeof scroll.x === "number" ? scroll.x : 0,
        y: typeof scroll.y === "number" ? scroll.y : 0,
      },
      formState: [],
    }
    const parsed = BrowserCheckpointSchema.safeParse(checkpoint)
    return parsed.success ? parsed.data : undefined
  }

  function stringRecord(value: unknown): Record<string, string> {
    if (!value || typeof value !== "object") return {}
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 10_000)
        .flatMap(([key, entry]) =>
          typeof entry === "string" ? [[key.slice(0, 10_000), entry.slice(0, 1_000_000)]] : [],
        ),
    )
  }

  async function migrateState(state: StoredState, digest: string): Promise<BrowserStorage.SessionState> {
    const page = pageFromState(state)
    const profile = page ? await BrowserProfiles.legacyDigest(digest) : null
    return {
      version: 5,
      timestamp: typeof state.timestamp === "number" ? state.timestamp : Date.now(),
      pages: page && profile ? [{ ...page, profileId: profile.id, isLoading: false, status: "suspended" }] : [],
      annotations: annotationsFromState(state),
      downloads: Array.isArray(state.downloads)
        ? (state.downloads as NonNullable<BrowserStorage.SessionState["downloads"]>)
        : [],
    }
  }

  function migratedError(value: unknown): BrowserProtocolErrorData | undefined {
    const parsed = BrowserProtocolErrorSchema.safeParse(value)
    if (parsed.success) return parsed.data
    if (typeof value !== "string" || !value.trim()) return undefined
    return {
      type: "error",
      code: "browser_migrated_failure",
      message: value.slice(0, 100_000),
      retryable: true,
      suggestedAction: "Resume the Browser page to retry recovery.",
    }
  }

  async function migrateRecord(owner: BrowserOwner.Info, key: string[]): Promise<Result> {
    const state = await readState(key)
    if (!state) return { ownerKey: BrowserOwner.key(owner), changed: false, version: BrowserStorage.CURRENT_VERSION }
    const next = await migrateState(state, BrowserOwner.storageID(owner))
    const target = BrowserStorage.keyForOwner(owner)
    const moved = JSON.stringify(key) !== JSON.stringify(target)
    const changed = moved || JSON.stringify(state) !== JSON.stringify(next)
    await Storage.transaction(async () => {
      if (changed) await BrowserStorage.save(owner, next)
      if (moved) await Storage.remove(key)
    })
    return { ownerKey: BrowserOwner.key(owner), changed, version: BrowserStorage.CURRENT_VERSION }
  }

  export async function run(owner: BrowserOwner.Info): Promise<Result> {
    const current = BrowserStorage.keyForOwner(owner)
    if (await readState(current)) return { ownerKey: BrowserOwner.key(owner), changed: false, version: 5 }
    const v4 = ["browser", "sessions-v4", BrowserOwner.storageID(owner)]
    if (await readState(v4)) return migrateRecord(owner, v4)
    return migrateRecord(owner, legacyStateKey(owner))
  }

  export async function runAll(progress?: (current: number, total: number) => void): Promise<void> {
    const records = await Storage.list(["browser", "sessions-v4"])
    for (const key of records) {
      const digest = key[2]!
      const target = ["browser", "sessions-v5", digest]
      if (await readState(target)) continue
      const old = await readState(key)
      if (old) await Storage.write(target, await migrateState(old, digest))
    }
    const keys = await Storage.list(["browser", "sessions"])
    let current = 0
    for (const key of keys) {
      const scopeID = key[2]
      if (!scopeID) throw new Error("Historical Browser state has no owner")
      const owner: BrowserOwner.Info =
        key[3] === "scope"
          ? { mode: "scope", scopeID, directory: "" }
          : { mode: "session", scopeID, sessionID: key[4], directory: "" }
      await migrateRecord(owner, key)
      progress?.(++current, keys.length)
    }
    if (!keys.length) progress?.(0, 0)
  }
}

function legacyComponent(value: string, label: string): string {
  if (!value || value === "." || value === ".." || value.includes("/") || value.includes("\\")) {
    throw new Error(`Legacy Browser ${label} identifier is unsafe.`)
  }
  return value
}

export const migrations: Migration[] = [
  {
    id: "20260929-browser-pages-and-identities-v5",
    description:
      "Migrate browser pages to Desktop identities without merging native partitions or deleting retired profiles",
    domain: "browser",
    async up(progress) {
      await BrowserMigration.runAll(progress)
    },
  },
]
