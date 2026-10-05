import { constants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { legacyRecordKey, sourcePath } from "./legacy-source"
import type { TransactionalStore } from "./transactional-store"

const Timestamp = z.number().finite().nonnegative()
const Ledger = z.record(z.string(), Timestamp)
const EmptyNavigation = z
  .object({ version: z.literal(1), scopeID: z.literal("home"), updatedAt: Timestamp, entries: z.array(z.never()) })
  .strict()
const ReclaimedScope = z
  .object({
    id: z.literal("__reclaimed__"),
    type: z.literal("project"),
    name: z.literal("Reclaimed"),
    icon: z.object({ color: z.literal("gray") }).strict(),
    directory: z.string(),
    worktree: z.string(),
    sandboxes: z.array(z.never()),
    time: z.object({ created: Timestamp, updated: Timestamp }).strict(),
  })
  .strict()
const EmptyPluginLock = z.object({ version: z.literal(2), plugins: z.record(z.string(), z.never()) }).strict()

async function readResidue(dataRoot: string, relative: string): Promise<unknown> {
  const flags = constants.O_RDONLY | constants.O_NONBLOCK | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW)
  const file = await fs.open(sourcePath(dataRoot, relative), flags)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > 1024 * 1024) return
    const bytes = Buffer.alloc(1024 * 1024 + 1)
    let size = 0
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, size)
      if (!bytesRead) break
      size += bytesRead
    }
    if (size > 1024 * 1024) return
    try {
      return JSON.parse(bytes.subarray(0, size).toString("utf8")) as unknown
    } catch (error) {
      if (error instanceof SyntaxError) return
      throw error
    }
  } finally {
    await file.close()
  }
}

export async function isLegacyStartupResidue(dataRoot: string, relative: string, store: TransactionalStore) {
  const ledger = /^meta\/migration\/log-[a-z0-9_-]+\.json$/.test(relative)
  const navigation = relative === "session_nav_v2/home.json"
  const reclaimed = relative === "projects/__reclaimed__.json"
  const plugin = ["plugin-approvals.json", "plugin-incompatible.json", "@home/plugin.lock"].includes(relative)
  if (!ledger && !navigation && !reclaimed && !plugin) return false
  const value = await readResidue(dataRoot, relative)
  if (value === undefined) return false
  if (reclaimed) {
    const parsed = ReclaimedScope.safeParse(value)
    if (!parsed.success) return false
    const directory = path.resolve(dataRoot, "..", "reclaimed")
    if (
      parsed.data.directory !== directory ||
      parsed.data.worktree !== directory ||
      parsed.data.time.created !== parsed.data.time.updated
    )
      return false
    const [canonical] = await store.readMany<unknown>([["meta", "migration", "log-scope"]])
    const log = Ledger.safeParse(canonical)
    return log.success && log.data["20260424-scope-reclaim-orphans"] !== undefined
  }
  const key = legacyRecordKey(relative)!
  const [canonical] = await store.readMany<unknown>([key])
  if (ledger) return Ledger.safeParse(value).success && Ledger.safeParse(canonical).success
  if (navigation)
    return (
      EmptyNavigation.safeParse(value).success &&
      EmptyNavigation.extend({ entries: z.array(z.unknown()) }).safeParse(canonical).success
    )
  if (relative === "@home/plugin.lock")
    return EmptyPluginLock.safeParse(value).success && EmptyPluginLock.safeParse(canonical).success
  return Array.isArray(value) && value.length === 0 && Array.isArray(canonical) && canonical.length === 0
}
