import { Storage } from "../storage/storage"
import { UpgradeWork } from "../storage/upgrade-work"

const inspectionTools = new Set([
  "read",
  "view_file",
  "view_image",
  "look_at",
  "scan_document",
  "browser_screenshot",
  "computer_observe",
  "computer_action",
])

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function upgradeAttachment(value: Record<string, unknown>, tool?: string) {
  if (value.type !== "attachment") return false
  const presentation = record(value.presentation)
  const metadata = record(record(value.metadata)?.attachment)
  let changed = false
  if (presentation?.purpose !== "evidence" && presentation?.purpose !== "deliverable") {
    const evidence =
      typeof metadata?.deliverable === "boolean"
        ? !metadata.deliverable
        : metadata?.detectedFrom === "line" || metadata?.detectedFrom === "path" || inspectionTools.has(tool ?? "")
    value.presentation = { ...presentation, purpose: evidence ? "evidence" : "deliverable" }
    changed = true
  }
  if (metadata && "deliverable" in metadata) {
    delete metadata.deliverable
    changed = true
  }
  return changed
}

export function upgradeAttachmentPresentation(value: Record<string, unknown>) {
  if (value.type === "attachment") return upgradeAttachment(value)
  if (value.type !== "tool") return false
  const attachments = record(value.state)?.attachments
  if (!Array.isArray(attachments)) return false
  let changed = false
  for (const attachment of attachments) {
    const item = record(attachment)
    if (item && upgradeAttachment(item, typeof value.tool === "string" ? value.tool : undefined)) changed = true
  }
  return changed
}

export async function migrateAttachmentPurposes(
  owner: { scopeID: string; sessionID: string },
  progress: (current: number, total: number) => void,
) {
  let writes: Array<{ key: string[]; value: Record<string, unknown> }> = []
  let bytes = 0
  let done = 0
  const flush = async () => {
    if (!writes.length) return
    await Storage.transaction((tx) => tx.writeMany(writes))
    writes = []
    bytes = 0
  }
  for await (const entry of Storage.records<Record<string, unknown>>({ kind: "part", ...owner })) {
    await UpgradeWork.checkpoint()
    const value = structuredClone(entry.value)
    if (upgradeAttachmentPresentation(value)) {
      const size = Buffer.byteLength(JSON.stringify(value))
      if (writes.length >= 100 || bytes + size > 4 * 1024 * 1024) await flush()
      writes.push({ key: entry.key, value })
      bytes += size
    }
    progress(++done, 0)
  }
  await flush()
  progress(done, done)
}
