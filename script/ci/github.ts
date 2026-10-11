import path from "node:path"
import { executionQueue, type Plan } from "./plan"
import type { UnitExecution } from "./evidence"

// Provenance: https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs
// Local adaptation: preserve the original plan and select results from each unit's latest actual execution on the same run and SHA.

export interface WorkflowJob {
  name: string
  run_attempt: number
  status: string
  conclusion: string | null
  created_at?: string
  started_at?: string | null
  completed_at?: string | null
}
interface Artifact {
  name: string
  expired: boolean
}

export function isInheritedJob(job: Pick<WorkflowJob, "status" | "created_at" | "started_at" | "completed_at">) {
  if (job.status !== "completed") return false
  const created = Date.parse(job.created_at ?? "")
  const started = Date.parse(job.started_at ?? "")
  const completed = Date.parse(job.completed_at ?? "")
  // Partial reruns copy completed siblings with new IDs and attempt numbers but retain their execution times.
  return (
    Number.isFinite(created) &&
    Number.isFinite(started) &&
    Number.isFinite(completed) &&
    started <= completed &&
    completed < created
  )
}

export function latestExecutions(plan: Plan, jobs: WorkflowJob[]): UnitExecution[] {
  const units = new Set([...plan.units.map((unit) => unit.id), "benchmark-prepare"])
  const executions = new Map<string, UnitExecution>()
  for (const job of jobs) {
    if (isInheritedJob(job)) continue
    const unit =
      job.name === "Frozen benchmark preparation"
        ? "benchmark-prepare"
        : /^(?:contracts|linux|docker|postgres|windows|macos) \((.+)\)$/.exec(job.name)?.[1]
    if (!unit || !units.has(unit) || job.run_attempt < Number(plan.attempt)) continue
    const previous = executions.get(unit)
    if (!previous || Number(previous.attempt) < job.run_attempt)
      executions.set(unit, { unit, attempt: String(job.run_attempt), status: job.status, conclusion: job.conclusion })
  }
  return [...executions.values()]
}

export function inputArtifact(
  plan: Plan,
  prefix: string,
  producer: string,
  jobs: WorkflowJob[],
  artifacts: Artifact[],
) {
  const job = jobs
    .filter((job) => job.name === producer && job.run_attempt >= Number(plan.attempt) && !isInheritedJob(job))
    .toSorted((a, b) => b.run_attempt - a.run_attempt)[0]
  if (!job) return undefined
  if (job.status === "completed" && job.conclusion !== "success")
    throw new Error(`CI input producer failed: ${producer}`)
  const artifact = artifacts.find((artifact) => artifact.name === `${prefix}-${job.run_attempt}`)
  if (artifact?.expired) throw new Error(`CI input expired: ${prefix}; rerun all jobs`)
  return artifact?.name
}

function client(plan: Plan) {
  const repository = process.env.GITHUB_REPOSITORY
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
  if (!repository || !token || !/^\d+$/.test(plan.run))
    throw new Error("CI artifact transfer requires workflow credentials")
  const cache = new Map<string, { etag: string; data: unknown }>()
  async function get<T>(suffix: string): Promise<T> {
    const previous = cache.get(suffix)
    const response = await fetch(
      `${process.env.GITHUB_API_URL ?? "https://api.github.com"}/repos/${repository}/actions/runs/${plan.run}${suffix}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          ...(previous ? { "If-None-Match": previous.etag } : {}),
        },
      },
    )
    if (response.status === 304 && previous) return previous.data as T
    if (!response.ok) throw new Error(`Cannot read CI artifact provenance: HTTP ${response.status}`)
    const data: unknown = await response.json()
    const etag = response.headers.get("etag")
    if (etag) cache.set(suffix, { etag, data })
    return data as T
  }
  return { repository, get }
}

async function allJobs(get: ReturnType<typeof client>["get"]) {
  const jobs: WorkflowJob[] = []
  for (let page = 1; ; page++) {
    const data = await get<{ jobs: WorkflowJob[] }>(`/jobs?filter=all&per_page=100&page=${page}`)
    jobs.push(...data.jobs)
    if (data.jobs.length < 100) return jobs
  }
}

export function reconcileExecutions(
  plan: Plan,
  executions: UnitExecution[],
  needs: Record<string, { result: string }>,
  attempt: string,
): UnitExecution[] {
  return executions.map((execution) => {
    const unit = plan.units.find((unit) => unit.id === execution.unit)
    const queue =
      execution.unit === "benchmark-prepare"
        ? "benchmark-prepare"
        : unit &&
          executionQueue(
            unit,
            plan.tasks.filter((task) => plan.selected.includes(task.id)),
          )
    // The final job's dependency result includes post-job completion; the Jobs API can lag behind that DAG.
    if (
      queue &&
      needs[queue]?.result === "success" &&
      execution.attempt === attempt &&
      execution.status === "in_progress" &&
      execution.conclusion === null
    )
      return { ...execution, status: "completed", conclusion: "success" }
    return execution
  })
}

export async function workflowExecutions(
  plan: Plan,
  options: { timeoutMs?: number; pollMs?: number; needs?: Record<string, { result: string }>; attempt?: string } = {},
) {
  const api = client(plan)
  const expected = [
    ...plan.units.map((unit) => unit.id),
    ...(plan.selected.includes("benchmark-prepare") ? ["benchmark-prepare"] : []),
  ]
  const deadline = Date.now() + (options.timeoutMs ?? 60_000)
  for (;;) {
    const executions = reconcileExecutions(
      plan,
      latestExecutions(plan, await allJobs(api.get)),
      options.needs ?? {},
      options.attempt ?? plan.attempt,
    )
    if (
      expected.every((unit) =>
        executions.some((execution) => execution.unit === unit && execution.status === "completed"),
      ) ||
      executions.some((execution) => execution.status === "completed" && execution.conclusion !== "success") ||
      Date.now() >= deadline
    )
      return executions
    await Bun.sleep(Math.min(options.pollMs ?? 1000, Math.max(0, deadline - Date.now())))
  }
}

export async function unpackInput(archive: string, destination: string) {
  const unpack = Bun.spawn(["tar", "--zstd", "-xpf", archive, "-C", destination], {
    stdout: "inherit",
    stderr: "inherit",
  })
  if (await unpack.exited) throw new Error(`Cannot unpack CI input: ${path.basename(archive)}`)
}

export async function downloadInput(plan: Plan, root: string, profile: "core" | "full" | "benchmark") {
  const prefix = profile === "benchmark" ? "ci-benchmark-prepared" : `ci-distribution-${profile}`
  const producer =
    profile === "benchmark" ? "Frozen benchmark preparation" : `${profile === "core" ? "Core" : "Full"} distribution`
  const api = client(plan)
  let missingSince: number | undefined
  // Workflow job deadlines bound active preparation; a shorter input timer would also charge runner queueing.
  for (;;) {
    const artifacts: Artifact[] = []
    for (let page = 1; ; page++) {
      const data = await api.get<{ artifacts: Artifact[] }>(`/artifacts?per_page=100&page=${page}`)
      artifacts.push(...data.artifacts)
      if (data.artifacts.length < 100) break
    }
    const jobs = await allJobs(api.get)
    const name = inputArtifact(plan, prefix, producer, jobs, artifacts)
    if (name) {
      const destination = path.join(root, ".artifacts/ci", profile === "benchmark" ? "" : "distributions")
      const download = Bun.spawn(
        ["gh", "run", "download", plan.run, "--repo", api.repository, "--name", name, "--dir", destination],
        { cwd: root, stdout: "inherit", stderr: "inherit" },
      )
      if (await download.exited) throw new Error(`Cannot download verified input: ${name}`)
      const archive = path.join(destination, profile === "benchmark" ? "benchmark.tar.zst" : `${profile}.tar.zst`)
      await unpackInput(archive, destination)
      return
    }
    const latest = jobs
      .filter((job) => job.name === producer && job.run_attempt >= Number(plan.attempt) && !isInheritedJob(job))
      .toSorted((a, b) => b.run_attempt - a.run_attempt)[0]
    if (latest?.status === "completed") {
      missingSince ??= Date.now()
      if (Date.now() - missingSince >= 60_000) throw new Error(`CI input missing or expired: ${prefix}; rerun all jobs`)
    } else missingSince = undefined
    await Bun.sleep(5000)
  }
}
