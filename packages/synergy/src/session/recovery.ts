import fs from "fs/promises"
import path from "path"
import { Global } from "@/global"
import { Identifier } from "@/id/id"
import { Storage } from "@/storage/storage"
import { StoragePath } from "@/storage/path"
import { SessionEndpoint } from "./endpoint"
import { SessionNav, type ScopeNavIndex } from "./nav"
import type { Info } from "./types"

export namespace SessionRecovery {
  export interface Location {
    sessionID: string
    scopeID: string
    directory?: string
    endpointKey?: string
  }

  export interface Health {
    sessionID: string
    scopeID: string
    infoReadable: boolean
    totalBytes: number
    messageCount: number
    partCount: number
    corruptJsonCount: number
    largestJsonBytes: number
  }

  export interface DeleteReport {
    sessionIDs: string[]
    removed: string[]
    missing: string[]
    errors: Array<{ target: string; message: string }>
  }

  export interface RepairReport {
    scanned: number
    repaired: number
    entries: Array<{ sessionID: string; scopeID: string; action: string }>
  }

  export async function resolve(input: { sessionID: string; scopeID?: string }): Promise<Location> {
    const sid = Identifier.asSessionID(input.sessionID)
    const index = await Storage.read<any>(StoragePath.sessionIndex(sid)).catch(() => undefined)
    const scopeID = input.scopeID ?? index?.scopeID
    if (!scopeID) throw new Error(`Scope is required for session ${input.sessionID}; pass --scope.`)
    return {
      sessionID: input.sessionID,
      scopeID,
      directory: index?.directory,
      endpointKey: index?.endpointKey,
    }
  }

  export async function health(input: { sessionID: string; scopeID: string }): Promise<Health> {
    const scope = Identifier.asScopeID(input.scopeID)
    const sid = Identifier.asSessionID(input.sessionID)
    const root = sessionRootPath(input.scopeID, input.sessionID)
    const [infoReadable, stats] = await Promise.all([
      Storage.read<Info>(StoragePath.sessionInfo(scope, sid))
        .then(() => true)
        .catch(() => false),
      scanJsonTree(root),
    ])
    const messageIDs = await Storage.scan(StoragePath.sessionMessagesRoot(scope, sid)).catch(() => [])
    let partCount = 0
    for (const messageID of messageIDs) {
      partCount += (
        await Storage.scan(StoragePath.messageParts(scope, sid, Identifier.asMessageID(messageID))).catch(() => [])
      ).length
    }
    return {
      sessionID: input.sessionID,
      scopeID: input.scopeID,
      infoReadable,
      totalBytes: stats.totalBytes,
      messageCount: messageIDs.length,
      partCount,
      corruptJsonCount: stats.corruptJsonCount,
      largestJsonBytes: stats.largestJsonBytes,
    }
  }

  export async function listHealth(scopeID: string): Promise<Health[]> {
    const scope = Identifier.asScopeID(scopeID)
    const ids = await Storage.scan(StoragePath.sessionsRoot(scope)).catch(() => [])
    const result: Health[] = []
    for (const sessionID of ids) result.push(await health({ scopeID, sessionID }))
    return result.sort((a, b) => b.totalBytes - a.totalBytes)
  }

  export async function inspect(input: { sessionID: string; scopeID?: string }): Promise<Health> {
    const location = await resolve(input)
    return health(location)
  }

  export async function remove(input: { sessionID: string; scopeID?: string }): Promise<DeleteReport> {
    const location = await resolve(input)
    const sessionIDs = await collectSessionTree(location.scopeID, location.sessionID)
    const report: DeleteReport = { sessionIDs, removed: [], missing: [], errors: [] }
    for (const sessionID of sessionIDs) {
      await removeOne({ ...location, sessionID }, report)
    }
    await cleanupIndexes(location.scopeID, new Set(sessionIDs), location.endpointKey, report)
    return report
  }

  export async function repair(input: { apply: boolean }): Promise<RepairReport> {
    const report: RepairReport = { scanned: 0, repaired: 0, entries: [] }
    const scopeIDs = await Storage.scan(["sessions"])
    for (const scopeID of scopeIDs) {
      const sessions = await listHealth(scopeID)
      report.scanned += sessions.length
      const broken = sessions.filter((entry) => !entry.infoReadable || entry.corruptJsonCount > 0)
      if (broken.length === 0) continue
      const ids = new Set(broken.map((entry) => entry.sessionID))
      for (const entry of broken) {
        report.entries.push({
          sessionID: entry.sessionID,
          scopeID,
          action: entry.infoReadable ? "corrupt-json" : "remove-from-indexes",
        })
      }
      if (input.apply) {
        const deleteReport: DeleteReport = { sessionIDs: [], removed: [], missing: [], errors: [] }
        await cleanupIndexes(scopeID, ids, undefined, deleteReport)
        report.repaired += ids.size
      }
    }
    return report
  }

  async function removeOne(location: Location, report: DeleteReport) {
    const scope = Identifier.asScopeID(location.scopeID)
    const sid = Identifier.asSessionID(location.sessionID)
    await removeTarget(
      `session:${location.sessionID}`,
      () => Storage.removeTree(StoragePath.sessionRoot(scope, sid)),
      report,
    )
    await removeTarget(
      `session-index:${location.sessionID}`,
      () => Storage.remove(StoragePath.sessionIndex(sid)),
      report,
    )
    await removeTarget(
      `snapshot:${location.sessionID}`,
      () =>
        fs.rm(path.join(Global.Path.snapshot, location.scopeID, location.sessionID), { recursive: true, force: true }),
      report,
    )
  }

  async function cleanupIndexes(
    scopeID: string,
    sessionIDs: Set<string>,
    endpointKey: string | undefined,
    report: DeleteReport,
  ) {
    const scope = Identifier.asScopeID(scopeID)
    const page = await Storage.read<any>(StoragePath.sessionsPageIndex(scope)).catch(() => undefined)
    if (page?.entries) {
      page.entries = page.entries.filter((entry: any) => !sessionIDs.has(entry.id))
      await removeTarget(
        `page-index:${scopeID}`,
        () => Storage.write(StoragePath.sessionsPageIndex(scope), page),
        report,
      )
    }

    const nav = await Storage.read<ScopeNavIndex>(StoragePath.sessionNavIndex(scope)).catch(() => undefined)
    if (nav?.entries) {
      nav.entries = nav.entries.filter((entry) => !sessionIDs.has(entry.id))
      nav.updatedAt = Date.now()
      await removeTarget(`nav-index:${scopeID}`, () => Storage.write(StoragePath.sessionNavIndex(scope), nav), report)
    }

    for (const sessionID of sessionIDs) {
      const sid = Identifier.asSessionID(sessionID)
      const info = await Storage.read<Info>(StoragePath.sessionInfo(scope, sid)).catch(() => undefined)
      const key = endpointKey ?? (info?.endpoint ? SessionEndpoint.toKey(info.endpoint) : undefined)
      if (key) {
        await removeTarget(
          `endpoint-index:${sessionID}`,
          () => Storage.remove(StoragePath.endpointSession(key, sid)),
          report,
        )
      }
      await removeTarget(`session-index:${sessionID}`, () => Storage.remove(StoragePath.sessionIndex(sid)), report)
      await SessionNav.removeNavEntry(scopeID, sessionID).catch(() => undefined)
    }
  }

  async function collectSessionTree(scopeID: string, rootSessionID: string): Promise<string[]> {
    const scope = Identifier.asScopeID(scopeID)
    const ids = await Storage.scan(StoragePath.sessionsRoot(scope)).catch(() => [])
    const children = new Map<string, string[]>()
    for (const id of ids) {
      const info = await Storage.read<Info>(StoragePath.sessionInfo(scope, Identifier.asSessionID(id))).catch(
        () => undefined,
      )
      if (!info?.parentID) continue
      const bucket = children.get(info.parentID) ?? []
      bucket.push(id)
      children.set(info.parentID, bucket)
    }
    const result: string[] = []
    const queue = [rootSessionID]
    while (queue.length) {
      const current = queue.shift()!
      result.push(current)
      queue.push(...(children.get(current) ?? []))
    }
    return result
  }

  async function removeTarget(label: string, action: () => Promise<unknown>, report: DeleteReport) {
    try {
      await action()
      report.removed.push(label)
    } catch (error) {
      report.errors.push({ target: label, message: error instanceof Error ? error.message : String(error) })
    }
  }

  async function scanJsonTree(root: string) {
    let totalBytes = 0
    let corruptJsonCount = 0
    let largestJsonBytes = 0
    const walk = async (dir: string) => {
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(full)
          continue
        }
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue
        const stat = await fs.stat(full).catch(() => undefined)
        if (!stat) continue
        totalBytes += stat.size
        largestJsonBytes = Math.max(largestJsonBytes, stat.size)
        try {
          JSON.parse(await Bun.file(full).text())
        } catch {
          corruptJsonCount++
        }
      }
    }
    await walk(root)
    return { totalBytes, corruptJsonCount, largestJsonBytes }
  }

  function sessionRootPath(scopeID: string, sessionID: string) {
    return path.join(
      Global.Path.data,
      ...StoragePath.sessionRoot(Identifier.asScopeID(scopeID), Identifier.asSessionID(sessionID)),
    )
  }
}
