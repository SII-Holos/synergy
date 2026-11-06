import type { ReencodeJobState } from "@ericsanchezok/synergy-sdk/client"

export function reencodeConflictJob(error: unknown): ReencodeJobState | undefined {
  if (!error || typeof error !== "object" || !("job" in error)) return undefined
  const job = error.job
  if (!job || typeof job !== "object" || !("id" in job) || !("status" in job)) return undefined
  return job as ReencodeJobState
}

export function isReencodeJobNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "REENCODE_JOB_NOT_FOUND")
}

type ReencodeJobResponse = {
  data?: ReencodeJobState
  error?: unknown
}

export async function currentReencodeJob(
  request: () => Promise<ReencodeJobResponse>,
): Promise<ReencodeJobState | undefined> {
  try {
    const response = await request()
    if (response.error) {
      if (isReencodeJobNotFound(response.error)) return
      throw response.error
    }
    if (!response.data) throw new Error("Reencode job response did not include a job")
    return response.data
  } catch (error) {
    if (isReencodeJobNotFound(error)) return
    throw error
  }
}

export async function startedReencodeJob(request: () => Promise<ReencodeJobResponse>): Promise<ReencodeJobState> {
  try {
    const response = await request()
    if (response.error) {
      const conflict = reencodeConflictJob(response.error)
      if (conflict) return conflict
      throw response.error
    }
    if (!response.data) throw new Error("Reencode job response did not include a job")
    return response.data
  } catch (error) {
    const conflict = reencodeConflictJob(error)
    if (conflict) return conflict
    throw error
  }
}

export function reencodeJobPercent(job: ReencodeJobState): number {
  if (job.totalCount === 0) return 0
  return Math.min(100, Math.round((job.completedCount / job.totalCount) * 100))
}

export function reencodeJobSummary(job: ReencodeJobState): string {
  const counts = `${job.okCount} updated, ${job.skippedCount} skipped, ${job.failedCount} failed`
  if (job.status === "completed") return `Complete: ${counts}`
  if (job.status === "cancelled") return `Cancelled after ${job.completedCount} of ${job.totalCount}: ${counts}`
  if (job.status === "interrupted") return `Interrupted after ${job.completedCount} of ${job.totalCount}: ${counts}`
  return `Failed after ${job.completedCount} of ${job.totalCount}: ${job.error ?? counts}`
}

function wait(ms: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"))
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timeout)
      reject(new DOMException("Aborted", "AbortError"))
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort)
      resolve()
    }, ms)
    signal.addEventListener("abort", abort, { once: true })
  })
}

export async function pollReencodeJob(input: {
  load: () => Promise<ReencodeJobState>
  onUpdate: (job: ReencodeJobState) => void
  signal: AbortSignal
  intervalMs?: number
}): Promise<ReencodeJobState | undefined> {
  while (!input.signal.aborted) {
    const job = await input.load()
    if (input.signal.aborted) return
    input.onUpdate(job)
    if (input.signal.aborted) return
    if (job.status !== "running") return job
    await wait(input.intervalMs ?? 500, input.signal)
  }
}
