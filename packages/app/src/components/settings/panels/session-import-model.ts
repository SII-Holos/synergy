import type { ForeignImportJobState } from "@ericsanchezok/synergy-sdk/client"

/** Progress percentage for the batch import meter (0–100). */
export function jobPercent(job: ForeignImportJobState): number {
  if (job.totalCount === 0) return 0
  return Math.min(100, Math.round((job.completedCount / job.totalCount) * 100))
}

/** Compact human summary of a terminal or running job. */
export function jobSummary(job: ForeignImportJobState): string {
  const counts = `${job.okCount} imported, ${job.failedCount} failed`
  if (job.status === "completed") return `Complete: ${counts}`
  if (job.status === "cancelled") return `Cancelled after ${job.completedCount} of ${job.totalCount}: ${counts}`
  return `Failed after ${job.completedCount} of ${job.totalCount}: ${job.error ?? counts}`
}

/** Human-readable file size. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
