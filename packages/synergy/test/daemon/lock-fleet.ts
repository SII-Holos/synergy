import fs from "fs/promises"

export type WorkerResult = { id: string; acquired?: boolean; ownerToken?: string; error?: string }

// Phase budgets sum to 145s inside the competition tests' 150s budget, so the
// full worst-case failure path (ready deadline + result deadline + reap
// grace) lands as the harness's named error, never Bun's blanket timeout.
const READY_DEADLINE_MS = 80_000
const RESULT_DEADLINE_MS = 45_000
const REAPER_GRACE_MS = 20_000

/**
 * Spawns the whole lock-worker fleet up front; workers park on the start
 * gate, so concurrent spawning is race-free (postmortem 0006). Every child
 * is recorded into `children` as soon as it exists, and a throwing spawn
 * reaps its partial fleet before rethrowing, so a mid-loop failure can
 * never leak parked workers outside the caller's cleanup.
 */
export async function spawnFleet(
  count: number,
  workerPath: string,
  env: Record<string, string | undefined>,
  children: Bun.Subprocess[],
): Promise<void> {
  const spawned: Bun.Subprocess[] = []
  try {
    for (let index = 0; index < count; index++) {
      const child = Bun.spawn([process.execPath, "run", workerPath], {
        env: { ...env, LOCK_WORKER_ID: String(index) },
        stdout: "ignore",
        stderr: "inherit",
      })
      children.push(child)
      spawned.push(child)
    }
  } catch (error) {
    await reapAll(spawned)
    throw error
  }
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
 * Waits until every worker has appended its result line. A newline-terminated
 * line that fails to parse can never become valid and fails the wait
 * immediately with the causal error; only the unterminated final segment of
 * an in-flight append is tolerated until it terminates.
 */
export async function waitForResults(
  resultPath: string,
  count: number,
  timeoutMessage: string,
  deadlineMs = RESULT_DEADLINE_MS,
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
  const segments = contents.split("\n")
  const results: WorkerResult[] = []
  for (const line of segments.slice(0, -1)) {
    if (!line) continue
    try {
      results.push(JSON.parse(line) as WorkerResult)
    } catch (error) {
      throw new Error(`Malformed lock worker result line: ${line}`, { cause: error })
    }
  }
  return results
}

/**
 * Kills every fleet member still running and awaits their exits behind a
 * grace bound, so failure cleanup can never hang a test past its own budget
 * and the failure signature stays the harness's deadline error rather than
 * Bun's blanket test timeout. The grace timer is cleared when the exits
 * settle first, so routine cleanup leaves no lingering timer holding the
 * process open.
 */
export async function reapAll(children: readonly Bun.Subprocess[], graceMs = REAPER_GRACE_MS): Promise<void> {
  for (const child of children) {
    if (child.exitCode === null) child.kill()
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, graceMs)
    Promise.all(children.map((child) => child.exited.catch(() => {})))
      .catch(() => {})
      .then(() => {
        clearTimeout(timer)
        resolve()
      })
  })
}

async function readLines(filePath: string): Promise<string[]> {
  return (await fs.readFile(filePath, "utf8").catch(() => "")).split("\n").filter(Boolean)
}
