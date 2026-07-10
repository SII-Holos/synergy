import fs from "node:fs/promises"
import path from "node:path"
import { sanitizeBrowserFilename } from "@ericsanchezok/synergy-browser"
import { BrowserOwner } from "./owner.js"
import { Global } from "../global/index.js"
import { ToolTimeout } from "../tool/timeout.js"

export namespace BrowserDownloads {
  export interface DownloadRecord {
    id: string
    pageID: string
    url: string
    suggestedFilename: string
    mimeType?: string
    state: "pending" | "completed" | "failed" | "blocked" | "cancelled"
    path?: string
    size?: number
    createdAt: number
  }

  interface ManagedRecord {
    record: DownloadRecord
  }

  const records = new Map<string, Map<string, ManagedRecord>>()
  const MAX_OWNER_RECORDS = 10_000

  export function list(owner: BrowserOwner.Info): DownloadRecord[] {
    return Array.from(records.get(BrowserOwner.key(owner))?.values() ?? [], (entry) => ({ ...entry.record }))
  }

  export function add(owner: BrowserOwner.Info, record: DownloadRecord): boolean {
    const key = BrowserOwner.key(owner)
    const ownerRecords = records.get(key) ?? new Map()
    if (!ownerRecords.has(record.id) && ownerRecords.size >= MAX_OWNER_RECORDS) return false
    ownerRecords.set(record.id, { record })
    records.set(key, ownerRecords)
    return true
  }

  export function get(owner: BrowserOwner.Info, id: string): DownloadRecord | undefined {
    const record = records.get(BrowserOwner.key(owner))?.get(id)?.record
    return record ? { ...record } : undefined
  }

  export function update(owner: BrowserOwner.Info, id: string, patch: Partial<DownloadRecord>): void {
    const entry = records.get(BrowserOwner.key(owner))?.get(id)
    if (entry) Object.assign(entry.record, patch)
  }

  export async function cancel(owner: BrowserOwner.Info, id: string): Promise<DownloadRecord> {
    const entry = records.get(BrowserOwner.key(owner))?.get(id)
    if (!entry) throw new Error(`Download ${id} was not found for this browser owner.`)
    if (entry.record.state === "cancelled") return { ...entry.record }
    if (entry.record.state !== "pending") {
      throw new Error(`Download ${id} cannot be cancelled after reaching ${entry.record.state} state.`)
    }
    entry.record.state = "cancelled"
    return { ...entry.record }
  }

  export async function wait(
    owner: BrowserOwner.Info,
    id: string,
    timeoutMs: number = ToolTimeout.DEFAULTS.browserDownloadsWaitMs,
    signal?: AbortSignal,
  ): Promise<DownloadRecord> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() <= deadline) {
      if (signal?.aborted) throw signal.reason ?? new Error("Download wait was cancelled.")
      const record = get(owner, id)
      if (!record) throw new Error(`Download ${id} was not found for this browser owner.`)
      if (record.state !== "pending") return record
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`Timed out waiting for download ${id} after ${timeoutMs}ms.`)
  }

  export async function managedPath(owner: BrowserOwner.Info, id: string, filename: string): Promise<string> {
    const safeName = sanitizeBrowserFilename(filename, "download")
    const directory = path.join(Global.Path.data, "browser", "downloads", BrowserOwner.storageID(owner), idSlug(id))
    const realDirectory = await ensureManagedDirectory(directory)
    return path.join(realDirectory, safeName)
  }

  export async function managedDirectory(owner: BrowserOwner.Info): Promise<string> {
    const directory = path.join(Global.Path.data, "browser", "downloads", BrowserOwner.storageID(owner))
    return ensureManagedDirectory(directory)
  }

  export async function exportTo(owner: BrowserOwner.Info, id: string, target: string): Promise<string> {
    const record = get(owner, id)
    if (!record) throw new Error(`Download ${id} was not found for this browser owner.`)
    if (record.state !== "completed" || !record.path) throw new Error(`Download ${id} is not complete.`)
    const ownerRoot = await fs.realpath(
      path.join(Global.Path.data, "browser", "downloads", BrowserOwner.storageID(owner)),
    )
    const sourceInfo = await fs.lstat(record.path)
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
      throw new Error(`Managed download ${id} is not a safe regular file.`)
    }
    const source = await fs.realpath(record.path)
    if (!source.startsWith(`${ownerRoot}${path.sep}`)) throw new Error(`Managed download ${id} escaped owner storage.`)
    const stat = await fs.stat(source)
    if (!stat.isFile()) throw new Error(`Managed download ${id} is not a regular file.`)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL)
    return target
  }

  export function clearForTest(): void {
    records.clear()
  }

  export function restore(owner: BrowserOwner.Info, restored: DownloadRecord[]): void {
    const root = path.resolve(Global.Path.data, "browser", "downloads", BrowserOwner.storageID(owner))
    const ownerRecords = new Map<string, ManagedRecord>()
    for (const record of restored) {
      if (!record?.id || record.pageID === undefined) continue
      const managedPath = record.path ? path.resolve(record.path) : undefined
      if (managedPath && !managedPath.startsWith(`${root}${path.sep}`)) continue
      ownerRecords.set(record.id, {
        record: {
          ...record,
          state: record.state === "pending" ? "failed" : record.state,
          ...(managedPath ? { path: managedPath } : {}),
        },
      })
    }
    if (ownerRecords.size) records.set(BrowserOwner.key(owner), ownerRecords)
  }
}

function idSlug(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200) || "download"
}

async function ensureManagedDirectory(directory: string): Promise<string> {
  const root = path.join(Global.Path.data, "browser", "downloads")
  await fs.mkdir(root, { recursive: true, mode: 0o700 })
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const info = await fs.lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Managed Browser download storage is unsafe.")
  const [realRoot, realDirectory] = await Promise.all([fs.realpath(root), fs.realpath(directory)])
  if (realDirectory !== realRoot && !realDirectory.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error("Managed Browser download storage escaped its root.")
  }
  return realDirectory
}
