import path from "node:path"
import type { Plan } from "./plan"
import type { UnitExecution } from "./evidence"

// Provenance: https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs
// Local adaptation: preserve the original plan and select results from each unit's latest actual execution on the same run and SHA.

export interface WorkflowJob {
  name: string
  run_attempt: number
  status: string
  conclusion: string | null
}
interface Artifact {
  name: string
  expired: boolean
}

export function latestExecutions(plan: Plan, jobs: WorkflowJob[]): UnitExecution[] {
  const units = new Set([...plan.units.map((unit) => unit.id), "benchmark-prepare"])
  const executions = new Map<string, UnitExecution>()
  for (const job of jobs) {
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
    .filter((job) => job.name === producer && job.run_attempt >= Number(plan.attempt))
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

export async function workflowExecutions(plan: Plan) {
  return latestExecutions(plan, await allJobs(client(plan).get))
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
  const deadline = Date.now() + 6 * 60_000
  while (Date.now() < deadline) {
    const artifacts: Artifact[] = []
    for (let page = 1; ; page++) {
      const data = await api.get<{ artifacts: Artifact[] }>(`/artifacts?per_page=100&page=${page}`)
      artifacts.push(...data.artifacts)
      if (data.artifacts.length < 100) break
    }
    const name = inputArtifact(plan, prefix, producer, await allJobs(api.get), artifacts)
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
    await Bun.sleep(5000)
  }
  throw new Error(`CI input unavailable: ${prefix}; rerun all jobs if its artifact expired`)
}
