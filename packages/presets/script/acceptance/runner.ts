import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { AcceptanceCase, Result, atomicJSON, digest, sealEvidence, verifyResult, type Evidence } from "./evidence"
import { readRequests } from "./provider"
import { artifactDigest } from "./artifacts"

const inputSchema = z
  .object({ name: z.string().min(1), path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict()
const PlanBody = z
  .object({
    version: z.literal(1),
    source: z.string().regex(/^[a-f0-9]{40}$/),
    directory: z.string(),
    cases: z.array(AcceptanceCase).min(1),
    inputs: z.array(inputSchema),
  })
  .strict()
export const Plan = PlanBody.extend({ digest: z.string().regex(/^[a-f0-9]{64}$/) })
export type Plan = z.infer<typeof Plan>
export type Driver = (context: {
  plan: Plan
  scenario: AcceptanceCase
  directory: string
  attempt: number
  checkpoint(barrier: string, files?: Array<Pick<Evidence, "path" | "kind">>): Promise<void>
}) => Promise<Pick<Result, "status" | "model" | "barriers" | "evidence" | "requests" | "reason">>

export async function makePlan(input: {
  source: string
  directory: string
  cases: AcceptanceCase[]
  inputs: Array<{ name: string; path: string }>
}): Promise<Plan> {
  if (new Set(input.cases.map((entry) => entry.id)).size !== input.cases.length) throw new Error("Duplicate case")
  if (new Set(input.inputs.map((entry) => entry.name)).size !== input.inputs.length) throw new Error("Duplicate input")
  const declared = input.inputs.some((entry) => entry.name === "runtime")
    ? input.inputs
    : [...input.inputs, { name: "runtime", path: process.execPath }]
  const inputs = await Promise.all(
    declared.map(async (entry) => ({
      name: entry.name,
      path: await fs.realpath(entry.path),
      sha256: await artifactDigest(entry.path),
    })),
  )
  const body = PlanBody.parse({
    version: 1,
    source: input.source,
    directory: path.resolve(input.directory),
    cases: input.cases,
    inputs,
  })
  const plan = { ...body, digest: digest(JSON.stringify(body)) }
  await fs.mkdir(plan.directory, { recursive: true, mode: 0o700 })
  const marker = await fs.open(path.join(plan.directory, "plan.lock"), "wx", 0o600)
  try {
    await atomicJSON(path.join(plan.directory, "plan.json"), plan)
  } finally {
    await marker.close()
  }
  return plan
}

export async function loadPlan(directory: string): Promise<Plan> {
  const plan = Plan.parse(await Bun.file(path.join(directory, "plan.json")).json())
  if (path.resolve(directory) !== plan.directory) throw new Error("Plan directory changed")
  await validateFreeze(plan)
  return plan
}

export async function validateFreeze(plan: Plan, source = plan.source) {
  const { digest: expected, ...body } = Plan.parse(plan)
  if (digest(JSON.stringify(body)) !== expected) throw new Error("Plan was changed after freezing")
  if (source !== plan.source) throw new Error("Frozen source changed")
  for (const input of plan.inputs) {
    if ((await artifactDigest(input.path)) !== input.sha256) throw new Error(`Frozen input changed: ${input.name}`)
  }
}

async function attempts(plan: Plan, id: string): Promise<number[]> {
  const directory = path.join(plan.directory, "cases", id)
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true })
    if (entries.some((entry) => !entry.isDirectory() || !/^[1-9]\d*$/.test(entry.name)))
      throw new Error("Invalid attempt inventory")
    return entries.map((entry) => Number(entry.name)).sort((a, b) => a - b)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return []
    throw error
  }
}

async function acquireLock(directory: string, resume: boolean) {
  const file = path.join(directory, "run.lock")
  const owner = { pid: process.pid, token: crypto.randomUUID() }
  async function claim() {
    const handle = await fs.open(file, "wx", 0o600)
    try {
      await handle.writeFile(JSON.stringify(owner))
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
  try {
    await claim()
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error
    if (!resume) throw new Error("Acceptance run is locked")
    let recovery
    try {
      recovery = await fs.open(path.join(directory, "recovery.lock"), "wx", 0o600)
    } catch {
      throw new Error("Acceptance run is locked during recovery")
    }
    try {
      const current = z
        .object({ pid: z.number().int().positive(), token: z.string() })
        .parse(await Bun.file(file).json())
      try {
        process.kill(current.pid, 0)
        throw new Error("Acceptance run is locked by a live process")
      } catch (failure) {
        if (!(failure instanceof Error && "code" in failure && failure.code === "ESRCH")) throw failure
      }
      await fs.mkdir(path.join(directory, "interrupted-locks"), { recursive: true })
      await fs.rename(file, path.join(directory, "interrupted-locks", `${crypto.randomUUID()}.json`))
      await claim()
    } finally {
      await recovery.close()
      await fs.unlink(path.join(directory, "recovery.lock"))
    }
  }
  return async () => {
    const current = await Bun.file(file).json()
    if (current.token !== owner.token) throw new Error("Run ownership changed")
    await fs.unlink(file)
  }
}

export async function execute(
  plan: Plan,
  drivers: Record<string, Driver>,
  options: { source: string; resume?: boolean; retry?: string[]; reason?: string },
) {
  await validateFreeze(plan, options.source)
  const executable = plan.inputs.find((entry) => entry.name === "runtime")
  if (!executable || digest(await Bun.file(process.execPath).bytes()) !== executable.sha256)
    throw new Error("Running executable differs from the frozen Runtime")
  const retry = new Set(options.retry ?? [])
  if (retry.size && (!options.resume || !options.reason?.trim())) throw new Error("Retries require resume and a reason")
  for (const id of retry) if (!plan.cases.some((entry) => entry.id === id)) throw new Error(`Unknown retry case: ${id}`)
  const unlock = await acquireLock(plan.directory, options.resume ?? false)
  try {
    const inventories = await Promise.all(plan.cases.map((scenario) => attempts(plan, scenario.id)))
    if (!options.resume && inventories.some((entries) => entries.length))
      throw new Error("Acceptance run already started; use resume")
    for (const [index, scenario] of plan.cases.entries()) {
      const previous = inventories[index]!
      if (previous.length && !retry.has(scenario.id)) continue
      await validateFreeze(plan, options.source)
      const attempt = (previous.at(-1) ?? 0) + 1
      const directory = path.join(plan.directory, "cases", scenario.id, String(attempt))
      const started = Date.now()
      await atomicJSON(path.join(directory, "start.json"), {
        plan: plan.digest,
        source: plan.source,
        case: scenario.id,
        attempt,
        started,
        ...(previous.length ? { retryReason: options.reason } : {}),
      })
      const driver = drivers[scenario.id]
      const progress: { barriers: string[]; evidence: Evidence[] } = { barriers: [], evidence: [] }
      async function checkpoint(barrier: string, files: Array<Pick<Evidence, "path" | "kind">> = []) {
        if (!scenario.barriers.includes(barrier) || progress.barriers.includes(barrier))
          throw new Error("Checkpoint must identify a new declared barrier")
        const evidence = await Promise.all(files.map((file) => sealEvidence(directory, file.path, file.kind)))
        if (
          new Set([...progress.evidence, ...evidence].map((entry) => entry.path)).size !==
          progress.evidence.length + evidence.length
        )
          throw new Error("Checkpoint evidence must use immutable unique paths")
        progress.barriers.push(barrier)
        progress.evidence.push(...evidence)
        await atomicJSON(path.join(directory, "progress.json"), { ...progress, at: Date.now() })
      }
      let output: Awaited<ReturnType<Driver>>
      try {
        output = driver
          ? await driver({ plan, scenario, directory, attempt, checkpoint })
          : {
              status: "uncovered",
              model: "not-applicable",
              barriers: [],
              evidence: [],
              requests: [],
              reason: "No driver registered",
            }
      } catch (error) {
        output = {
          status: "failed",
          model: scenario.live ? "unknown" : "not-applicable",
          barriers: [],
          evidence: [],
          requests: [],
          reason: error instanceof Error ? error.name : "UnknownError",
        }
        await atomicJSON(path.join(directory, "failure.json"), {
          error: error instanceof Error ? error.name : "UnknownError",
          message: error instanceof Error ? error.message : String(error),
        })
      }
      const result = Result.parse({
        version: 1,
        plan: plan.digest,
        source: plan.source,
        case: scenario.id,
        attempt,
        started,
        finished: Date.now(),
        ...output,
        barriers: [...new Set([...progress.barriers, ...output.barriers])],
        evidence: [
          ...progress.evidence,
          ...output.evidence.filter((entry) => !progress.evidence.some((saved) => saved.path === entry.path)),
        ],
      })
      if (progress.barriers.length) result.evidence.push(await sealEvidence(directory, "progress.json", "transport"))
      const recorded = await readRequests(directory)
      if (recorded.length) result.requests = recorded
      for (const request of recorded) {
        for (const file of ["request.json", "request.bin", "response.json", "response.bin", "delivered.bin"]) {
          const relative = `requests/${request.id}/${file}`
          if (await Bun.file(path.join(directory, relative)).exists())
            result.evidence.push(await sealEvidence(directory, relative, "transport"))
        }
      }
      const errors = await verifyResult(directory, scenario, result, { plan: plan.digest, source: plan.source })
      if (result.status === "passed" && errors.length)
        result.status = errors.some((error) => error.startsWith("untriggered:") || error.startsWith("uncovered:"))
          ? "uncovered"
          : "failed"
      await atomicJSON(path.join(directory, "result.json"), result)
      await atomicJSON(path.join(directory, "verification.json"), { errors })
      process.stdout.write(`${scenario.id}: ${result.status}\n`)
    }
  } finally {
    await unlock()
  }
}

export async function report(plan: Plan) {
  const errors: string[] = []
  try {
    await validateFreeze(plan)
  } catch {
    errors.push("Frozen inputs or plan changed")
  }
  const cases = await Promise.all(
    plan.cases.map(async (scenario) => {
      const inventory = await attempts(plan, scenario.id)
      const attempt = inventory.at(-1)
      if (!attempt)
        return {
          id: scenario.id,
          status: "pending",
          attempts: 0,
          errors: ["Not executed"],
          requests: [] as Result["requests"],
        }
      const directory = path.join(plan.directory, "cases", scenario.id, String(attempt))
      try {
        const result = Result.parse(await Bun.file(path.join(directory, "result.json")).json())
        const failures = await verifyResult(directory, scenario, result, { plan: plan.digest, source: plan.source })
        if (result.attempt !== attempt) failures.push("attempt")
        if (attempt > 1) {
          const start = await Bun.file(path.join(directory, "start.json")).json()
          if (typeof start.retryReason !== "string" || !start.retryReason.trim()) failures.push("missing-retry-reason")
        }
        return {
          id: scenario.id,
          status: result.status === "passed" && failures.length ? "failed" : result.status,
          attempts: inventory.length,
          errors: failures,
          requests: result.requests,
        }
      } catch {
        return {
          id: scenario.id,
          status: "unknown",
          attempts: inventory.length,
          errors: ["Missing or invalid result"],
          requests: [] as Result["requests"],
        }
      }
    }),
  )
  const requests: Result["requests"] = []
  let unaccountedAttempts = 0
  for (const scenario of plan.cases)
    for (const attempt of await attempts(plan, scenario.id)) {
      const directory = path.join(plan.directory, "cases", scenario.id, String(attempt))
      const recorded = await readRequests(directory)
      if (recorded.length) {
        requests.push(...recorded)
        continue
      }
      try {
        const result = Result.parse(
          await Bun.file(path.join(plan.directory, "cases", scenario.id, String(attempt), "result.json")).json(),
        )
        requests.push(...result.requests)
      } catch {
        unaccountedAttempts++
      }
    }
  return {
    source: plan.source,
    plan: plan.digest,
    passed: !errors.length && cases.every((entry) => entry.status === "passed" && !entry.errors.length),
    errors,
    cases: cases.map(({ requests: _, ...entry }) => entry),
    usage: {
      requests: requests.length,
      unaccountedAttempts,
      unknownUsage: requests.filter(
        (entry) => entry.usage === null || entry.usage.input === null || entry.usage.output === null,
      ).length,
      input: requests.reduce((sum, entry) => sum + (entry.usage?.input ?? 0), 0),
      output: requests.reduce((sum, entry) => sum + (entry.usage?.output ?? 0), 0),
    },
    limits: [
      "No Windows local acceptance",
      "No live cloud object storage acceptance",
      "No multi-replica takeover acceptance",
    ],
  }
}
