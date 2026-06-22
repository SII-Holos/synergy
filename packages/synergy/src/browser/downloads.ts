import type { Page } from "playwright"

function nextId(): string {
  return `dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export namespace BrowserDownloads {
  export interface DownloadRecord {
    id: string
    tabID: string
    url: string
    suggestedFilename: string
    mimeType?: string
    state: "pending" | "completed" | "failed" | "blocked"
    path?: string
    size?: number
    createdAt: number
  }

  let records: DownloadRecord[] = []

  export function list(): DownloadRecord[] {
    return records
  }

  export function add(rec: DownloadRecord): void {
    records.push(rec)
  }

  export function remove(id: string): boolean {
    const idx = records.findIndex((r) => r.id === id)
    if (idx === -1) return false
    records.splice(idx, 1)
    return true
  }

  export function get(id: string): DownloadRecord | undefined {
    return records.find((r) => r.id === id)
  }

  export function update(id: string, patch: Partial<DownloadRecord>): void {
    const rec = records.find((r) => r.id === id)
    if (rec) Object.assign(rec, patch)
  }

  export function clear(): void {
    records = []
  }

  const TERMINAL_STATES: ReadonlySet<DownloadRecord["state"]> = new Set(["completed", "failed", "blocked"])

  export async function waitForDownload(id: string, timeoutMs = 30_000): Promise<DownloadRecord> {
    const rec = get(id)
    if (!rec) throw new Error(`Download record ${id} not found`)
    if (TERMINAL_STATES.has(rec.state)) return rec

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10))
      const current = get(id)
      if (!current) throw new Error(`Download record ${id} not found`)
      if (TERMINAL_STATES.has(current.state)) return current
    }
    throw new Error(`waitForDownload timed out after ${timeoutMs}ms for ${id}`)
  }

  export function attachToPage(page: Page): void {
    // Register download handler that populates in-memory records
    page.on("download", async (download) => {
      const id = nextId()
      const tabID = ((download.page() as unknown as Record<string, unknown>)._synergyTabID as string) ?? "unknown"
      const rec: DownloadRecord = {
        id,
        tabID,
        url: download.url(),
        suggestedFilename: download.suggestedFilename(),
        state: "pending",
        createdAt: Date.now(),
      }
      add(rec)
      try {
        const dpath = await download.path()
        if (dpath) {
          update(id, { state: "completed", path: dpath })
        } else {
          update(id, { state: "completed" })
        }
      } catch (err) {
        update(id, { state: "failed" })
      }
    })
  }

  export async function waitForPageDownload(page: Page, id: string, timeoutMs = 30_000): Promise<DownloadRecord> {
    return waitForDownload(id, timeoutMs)
  }
}
