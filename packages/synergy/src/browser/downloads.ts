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
}
