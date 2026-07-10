import path from "path"
import fs from "fs/promises"
import z from "zod"
import { BrowserOwner } from "./owner.js"
import { Global } from "../global/index.js"
import {
  BrowserCheckpointSchema,
  BrowserPageIdSchema,
  BrowserProtocolErrorSchema,
} from "@ericsanchezok/synergy-browser"

const StoredAnnotationSchema = z
  .object({
    id: z.string().min(1).max(20_000),
    pageURL: z.string().max(20_000),
    pageID: BrowserPageIdSchema,
    ref: z.string().max(20_000).optional(),
    element: z.string().max(100_000).optional(),
    comment: z.string().min(1).max(20_000),
    styleFeedback: z.record(z.string().max(1_000), z.string().max(10_000)).optional(),
    resolved: z.boolean(),
    createdAt: z.number().int().nonnegative(),
  })
  .strict()

const StoredDownloadSchema = z
  .object({
    id: z.string().min(1).max(20_000),
    pageID: BrowserPageIdSchema,
    url: z.string().max(20_000),
    suggestedFilename: z.string().min(1).max(1_024),
    mimeType: z.string().max(256).optional(),
    state: z.enum(["pending", "completed", "failed", "blocked", "cancelled"]),
    path: z.string().max(20_000).optional(),
    size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    createdAt: z.number().int().nonnegative(),
  })
  .strict()

const StoredSessionSchema = z
  .object({
    version: z.literal(4),
    status: z.enum(["empty", "suspended", "active", "migrating", "failed"]),
    page: z
      .object({
        id: BrowserPageIdSchema,
        url: z.string().max(20_000),
        title: z.string().max(20_000),
        lastActiveAt: z.number().int().nonnegative().nullable().optional(),
      })
      .strict()
      .nullable(),
    panelWidth: z.number().int().min(1).max(16_384).optional(),
    timestamp: z.number().int().nonnegative(),
    annotations: z.array(StoredAnnotationSchema).max(10_000).optional(),
    downloads: z.array(StoredDownloadSchema).max(10_000).optional(),
    checkpoint: BrowserCheckpointSchema.optional(),
    error: BrowserProtocolErrorSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status === "failed" && !value.error) {
      ctx.addIssue({ code: "custom", path: ["error"], message: "Failed Browser state requires a structured error." })
    }
  })

export namespace BrowserStorage {
  export const CURRENT_VERSION = 4

  export type StoredAnnotation = z.infer<typeof StoredAnnotationSchema>
  export type SessionState = Omit<z.infer<typeof StoredSessionSchema>, "version"> & { version?: number }

  function stateFilePath(owner: BrowserOwner.Info): string {
    BrowserOwner.assertValid(owner)
    return path.join(Global.Path.data, "browser", "sessions-v4", `${BrowserOwner.storageID(owner)}.json`)
  }

  export function profileDir(owner: BrowserOwner.Info): string {
    return path.join(Global.Path.data, "browser", "profiles", BrowserOwner.storageID(owner))
  }

  export function storageStatePath(owner: BrowserOwner.Info): string {
    return path.join(profileDir(owner), "storage-state.json")
  }

  export function uploadsDir(owner: BrowserOwner.Info): string {
    return path.join(Global.Path.data, "browser", "uploads", BrowserOwner.storageID(owner))
  }

  export function downloadsDir(owner: BrowserOwner.Info): string {
    return path.join(Global.Path.data, "browser", "downloads", BrowserOwner.storageID(owner))
  }

  function sanitizeUrl(url: string): string {
    if (!url) return url
    try {
      const parsed = new URL(url)
      if (parsed.protocol === "file:") return "[local file]"
      return parsed.toString()
    } catch {
      return url
    }
  }

  /** Read state. Returns null if no state file or on any read error. */
  export async function load(owner: BrowserOwner.Info): Promise<SessionState | null> {
    const fp = stateFilePath(owner)
    try {
      await assertSecureDirectory(path.dirname(fp), path.join(Global.Path.data, "browser"))
      const stat = await fs.lstat(fp)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) return null
      const state = StoredSessionSchema.parse(JSON.parse(await fs.readFile(fp, "utf8")))
      return { ...state, page: state.page ? { ...state.page, url: sanitizeUrl(state.page.url) } : null }
    } catch {
      return null
    }
  }

  /** Persist session state. Creates parent dirs if needed. */
  export async function save(owner: BrowserOwner.Info, state: SessionState): Promise<void> {
    const sanitized = StoredSessionSchema.parse({
      ...state,
      version: CURRENT_VERSION,
      status:
        state.page && (state.status === "active" || state.status === "migrating")
          ? state.status
          : state.status === "failed"
            ? "failed"
            : state.page
              ? "suspended"
              : "empty",
      page: state.page ? { ...state.page, url: sanitizeUrl(state.page.url) } : null,
    })
    const fp = stateFilePath(owner)
    await ensureSecureDirectory(path.dirname(fp), path.join(Global.Path.data, "browser"))
    const temporary = `${fp}.${crypto.randomUUID()}.tmp`
    let failure: unknown
    try {
      await fs.writeFile(temporary, JSON.stringify(sanitized, null, 2), { flag: "wx", mode: 0o600 })
      await replaceFileAtomically(temporary, fp)
    } catch (error) {
      failure = error
    }
    try {
      await fs.rm(temporary, { force: true })
    } catch (cleanupError) {
      if (failure) throw new AggregateError([failure, cleanupError], "Browser state save and cleanup both failed.")
      throw cleanupError
    }
    if (failure) throw failure
  }

  /** Remove session state. */
  export async function remove(owner: BrowserOwner.Info): Promise<void> {
    const fp = stateFilePath(owner)
    try {
      await assertSecureDirectory(path.dirname(fp), path.join(Global.Path.data, "browser"))
      await fs.unlink(fp)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }

  /** Get storage path for an owner. */
  export function pathForOwner(owner: BrowserOwner.Info): string {
    return stateFilePath(owner)
  }

  export async function ensureOwnerDirs(owner: BrowserOwner.Info): Promise<void> {
    const browserRoot = path.join(Global.Path.data, "browser")
    await ensureSecureDirectory(path.dirname(stateFilePath(owner)), browserRoot)
    await ensureSecureDirectory(profileDir(owner), path.join(browserRoot, "profiles"))
    await ensureSecureDirectory(uploadsDir(owner), path.join(browserRoot, "uploads"))
    await ensureSecureDirectory(downloadsDir(owner), path.join(browserRoot, "downloads"))
  }

  export async function replaceFileAtomically(source: string, target: string): Promise<void> {
    try {
      await fs.rename(source, target)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "EEXIST" && code !== "EPERM" && code !== "ENOTEMPTY") throw error
    }
    const backup = `${target}.${crypto.randomUUID()}.bak`
    let moved = false
    try {
      await fs.rename(target, backup)
      moved = true
      await fs.rename(source, target)
      await fs.rm(backup, { force: true })
    } catch (error) {
      if (moved) {
        try {
          await fs.rename(backup, target)
        } catch (restoreError) {
          throw new AggregateError([error, restoreError], "Browser state replacement and rollback both failed.")
        }
      }
      throw error
    }
  }
}

async function ensureSecureDirectory(directory: string, boundary: string): Promise<void> {
  await fs.mkdir(boundary, { recursive: true, mode: 0o700 })
  await assertSecureDirectory(boundary, path.dirname(boundary))
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  await assertSecureDirectory(directory, boundary)
}

async function assertSecureDirectory(directory: string, boundary: string): Promise<void> {
  const info = await fs.lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Browser storage directory is unsafe.")
  const [realDirectory, realBoundary] = await Promise.all([fs.realpath(directory), fs.realpath(boundary)])
  if (realDirectory !== realBoundary && !realDirectory.startsWith(`${realBoundary}${path.sep}`)) {
    throw new Error("Browser storage directory escaped its boundary.")
  }
  await fs.chmod(directory, 0o700)
}
