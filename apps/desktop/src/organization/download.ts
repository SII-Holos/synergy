import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import type { OrganizationDesktop as Desktop } from "@ericsanchezok/synergy-organization-protocol"

export async function saveOrganizationDownload(options: {
  fileName: string
  signal: AbortSignal
  choose: (fileName: string) => Promise<string | undefined>
  write: (append: (chunk: Uint8Array) => Promise<void>) => Promise<number>
}): Promise<Desktop.DownloadResult> {
  const check = () => {
    if (options.signal.aborted) throw new DOMException("Download cancelled", "AbortError")
  }
  check()
  const target = await options.choose(options.fileName)
  check()
  if (!target) return { saved: false }
  const temporary = path.join(path.dirname(target), `.synergy-download-${randomUUID()}.part`)
  const file = await fs.open(temporary, "wx", 0o600)
  try {
    const bytes = await options.write(async (chunk) => {
      let offset = 0
      while (offset < chunk.byteLength) {
        check()
        const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset)
        if (!bytesWritten) throw new Error("Download write did not advance")
        offset += bytesWritten
      }
    })
    check()
    await file.sync()
    await file.close()
    check()
    await fs.rename(temporary, target)
    return { saved: true, bytes }
  } finally {
    await file.close().catch(() => {})
    await fs.rm(temporary, { force: true })
  }
}
