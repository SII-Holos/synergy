import fs from "fs/promises"

export type WorkerResult = { id: string; acquired?: boolean; ownerToken?: string; error?: string }

const READY_DEADLINE_MS = 90_000
const REAPER_GRACE_MS = 20_000

/**
 * Spawns the whole lock-worker fleet up front; workers park on the start
 * gate, so concurrent spawning is race-free (postmortem 0006).
 */
export function spawnFleet(
  count: number,
  workerPath: string,
  env: Record<string, string | undefined>,
): Bun.Subprocess[] {
  return Array.from({ length: count }, (_, index) =>
    Bun.spawn([process.execPath, "run", workerPath], {
      env: { ...env, LOCK_WORKER_ID: String(index) },
      stdout: "ignore",
      stderr: "inherit",
    }),
  )
}

/**
 * Waits for every worker to report ready against one phase deadline sized
 * above the worst observed CI startup tail — never a sum of per-worker
 * waits. A worker that exits before reporting ready fails the wait
 * immediately: parked workers only ever exit on crash, so the missing ready
 * line is a diagnosable spawn failure instead of a deadline wait.
 */
export async function waitReady(
  children: readonly Bun.Subprocess[],
  readyPath: string,
  readyDeadlineMs = READY_DEADLINE_MS,
): Promise<void> {
  const readyDeadline = Date.now() + readyDeadlineMs
  const ready = new Set<string>()
  while (ready.size < children.length) {
    for (const line of await readLines(readyPath)) ready.add(line)
    if (ready.size >= children.length) return
    const crashed = children.filter((child) => child.exitCode !== null)
    if (crashed.length > 0) {
      throw new Error(
        `${crashed.length} lock worker(s) exited before becoming ready (exit code ${crashed
          .map((child) => child.exitCode)
          .join(", ")}; ${ready.size}/${children.length} ready)`,
      )
    }
    if (Date.now() >= readyDeadline) {
      throw new Error(`Lock workers did not become ready (${ready.size}/${children.length})`)
    }
    await Bun.sleep(50)
  }
}

/**
 * Waits until every worker has appended its result line. A partially
 * written line means a worker is mid-append; the poll retries instead of
 * failing the test on a transient parse error.
 */
export async function waitForResults(
  resultPath: string,
  count: number,
  deadlineMs: number,
  timeoutMessage: string,
): Promise<WorkerResult[]> {
  const resultDeadline = Date.now() + deadlineMs
  let results: WorkerResult[] = []
  while (results.length < count) {
    if (Date.now() >= resultDeadline) throw new Error(timeoutMessage)
    results = parseResults(await fs.readFile(resultPath, "utf8").catch(() => ""))
    await Bun.sleep(10)
  }
  return results
}

function parseResults(contents: string): WorkerResult[] {
  const results: WorkerResult[] = []
  for (const line of contents.split("\n")) {
    if (!line) continue
    try {
      results.push(JSON.parse(line) as WorkerResult)
    } catch {
      return []
    }
  }
  return results
}

/**
 * Kills every fleet member still running and awaits their exits behind a
 * grace bound, so failure cleanup can never hang a test past its own budget
 * and the failure signature stays the harness's deadline error rather than
 * Bun's blanket test timeout.
 */
export async function reapAll(children: readonly Bun.Subprocess[], graceMs = REAPER_GRACE_MS): Promise<void> {
  for (const child of children) {
    if (child.exitCode === null) child.kill()
  }
  await Promise.race([Promise.all(children.map((child) => child.exited.catch(() => {}))), Bun.sleep(graceMs)])
}

async function readLines(filePath: string): Promise<string[]> {
  return (await fs.readFile(filePath, "utf8").catch(() => "")).split("\n").filter(Boolean)
}
