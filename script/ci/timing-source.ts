import { execFileSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { validateTimings } from "./timing"

interface Run {
  id: number
  run_attempt: number
  head_branch: string
  head_sha: string
  event: string
  path: string
  status: string
  conclusion: string
  updated_at: string
  head_repository: { full_name: string } | null
}
interface Artifact {
  id: number
  name: string
  expired: boolean
  size_in_bytes: number
}

export function trustedTimingRun(runs: Run[], repository: string, now = Date.now()) {
  return runs
    .filter(
      (run) =>
        run.head_branch === "dev" &&
        run.head_repository?.full_name === repository &&
        run.path === ".github/workflows/ci.yml" &&
        ["push", "schedule", "workflow_dispatch"].includes(run.event) &&
        run.status === "completed" &&
        run.conclusion === "success" &&
        /^[a-f0-9]{40}$/.test(run.head_sha) &&
        Number.isSafeInteger(run.id) &&
        run.id > 0 &&
        Number.isSafeInteger(run.run_attempt) &&
        run.run_attempt > 0 &&
        Date.parse(run.updated_at) <= now &&
        now - Date.parse(run.updated_at) <= 7 * 24 * 60 * 60 * 1000,
    )
    .toSorted((a, b) => b.updated_at.localeCompare(a.updated_at))[0]
}

export function timingArtifact(artifacts: Artifact[], run: Run) {
  return artifacts.find(
    (artifact) =>
      artifact.name === `ci-summary-${run.run_attempt}` &&
      !artifact.expired &&
      Number.isSafeInteger(artifact.id) &&
      artifact.id > 0 &&
      artifact.size_in_bytes > 0 &&
      artifact.size_in_bytes <= 16 * 1024 * 1024,
  )
}

export async function planningTimings(root: string) {
  const fallback = {
    snapshot: validateTimings(await Bun.file(path.join(root, "script/ci/timings.json")).json()),
    source: "repository",
  }
  const repository = process.env.GITHUB_REPOSITORY
  if (!repository || !process.env.GH_TOKEN || !process.env.GITHUB_RUN_ID) return fallback
  const directory = await mkdtemp(path.join(os.tmpdir(), "ci-timings-"))
  try {
    const get = async <T>(suffix: string): Promise<T> => {
      const response = await fetch(`https://api.github.com/repos/${repository}/${suffix}`, {
        headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) throw new Error(`timing metadata HTTP ${response.status}`)
      return response.json() as Promise<T>
    }
    const recent = await get<{ workflow_runs: Run[] }>(
      "actions/workflows/ci.yml/runs?branch=dev&status=success&per_page=20",
    )
    const run = trustedTimingRun(recent.workflow_runs, repository)
    if (!run) return fallback
    const artifact = timingArtifact(
      (await get<{ artifacts: Artifact[] }>(`actions/runs/${run.id}/artifacts?per_page=100`)).artifacts,
      run,
    )
    if (!artifact) return fallback
    execFileSync(
      "gh",
      ["run", "download", String(run.id), "--repo", repository, "--name", artifact.name, "--dir", directory],
      {
        timeout: 20_000,
        stdio: "pipe",
      },
    )
    const file = Bun.file(path.join(directory, "timings.json"))
    if (file.size > 16 * 1024 * 1024) throw new Error("Timing snapshot exceeds its size budget")
    return {
      snapshot: validateTimings(await file.json()),
      source: `${repository}/runs/${run.id}/attempts/${run.run_attempt}/artifacts/${artifact.id}@${run.head_sha}`,
    }
  } catch {
    console.warn("::warning::Recent trusted timing input unavailable; using repository weights")
    return fallback
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
