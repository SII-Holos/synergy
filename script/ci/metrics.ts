import { appendFile } from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"
import { execFileSync } from "node:child_process"
import { OUTPUT, ROOT } from "./catalog"

interface Job {
  id: number
  name: string
  status: string
  conclusion: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
  runner_name: string
  labels: string[]
  run_attempt?: number
}
export function summarize(created: string, input: Job[], now = Date.now(), attempt?: number) {
  const first = Date.parse(created)
  const jobs = [
    ...new Map(
      input
        .filter(
          (job) =>
            attempt === undefined ||
            (job.run_attempt !== undefined ? job.run_attempt === attempt : Date.parse(job.created_at) >= first),
        )
        .map((job) => [job.id, job]),
    ).values(),
  ]
  const elapsed = (job: Job) =>
    job.started_at ? Math.max(0, (Date.parse(job.completed_at ?? "") || now) - Date.parse(job.started_at)) / 1000 : 0
  return {
    endToEndSeconds: (Math.max(first, ...jobs.map((job) => Date.parse(job.completed_at ?? "") || now)) - first) / 1000,
    runnerSeconds: jobs.reduce((sum, job) => sum + elapsed(job), 0),
    jobs: jobs.map((job) => ({
      id: job.id,
      name: job.name,
      labels: job.labels,
      status: job.status,
      conclusion: job.conclusion,
      queueSeconds:
        Math.max(0, (job.started_at ? Date.parse(job.started_at) : now) - Date.parse(job.created_at)) / 1000,
      runSeconds: elapsed(job),
    })),
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      repo: { type: "string" },
      run: { type: "string" },
      attempt: { type: "string" },
      cache: { type: "string" },
      load: { type: "string" },
      output: { type: "string" },
    },
  })
  const repository = values.repo ?? process.env.GITHUB_REPOSITORY
  const run = values.run ?? process.env.GITHUB_RUN_ID
  const attempt = values.attempt ?? process.env.GITHUB_RUN_ATTEMPT ?? "1"
  if (!repository || !run || !/^\d+$/.test(run) || !/^[1-9]\d*$/.test(attempt))
    throw new Error("Metrics require a repository, run ID and positive attempt")
  const get = async (suffix: string) => {
    const endpoint = `repos/${repository}/actions/runs/${run}${suffix}`
    if (!process.env.GH_TOKEN)
      return JSON.parse(
        execFileSync("gh", ["api", endpoint], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }),
      ) as unknown
    const response = await fetch(`https://api.github.com/${endpoint}`, {
      headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: "application/vnd.github+json" },
    })
    if (!response.ok) throw new Error(`Cannot read run metrics: ${response.status}`)
    return response.json()
  }
  const metadata = (await get(`/attempts/${attempt}`)) as {
    created_at: string
    run_started_at: string
    event: string
    head_sha: string
    status: string
  }
  const jobs: Job[] = []
  for (let page = 1; ; page++) {
    const data = (await get(`/attempts/${attempt}/jobs?per_page=100&page=${page}`)) as { jobs: Job[] }
    jobs.push(...data.jobs)
    if (data.jobs.length < 100) break
  }
  const summary = summarize(
    Number(attempt) === 1 ? metadata.created_at : metadata.run_started_at,
    jobs,
    Date.now(),
    Number(attempt),
  )
  const metrics = {
    run,
    attempt,
    event: metadata.event,
    headSha: metadata.head_sha,
    load: values.load ?? "unknown",
    cache: values.cache ?? process.env.CI_CACHE_STATE ?? (metadata.event === "schedule" ? "cold" : "unknown"),
    measuredAt: new Date().toISOString(),
    partial: metadata.status !== "completed" || summary.jobs.some((job) => job.status !== "completed"),
    ...summary,
  }
  await Bun.write(values.output ?? path.join(ROOT, OUTPUT, "metrics.json"), JSON.stringify(metrics, null, 2))
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `\nElapsed including queues: ${(metrics.endToEndSeconds / 60).toFixed(1)} min; compute so far: ${(metrics.runnerSeconds / 60).toFixed(1)} runner min. ${metrics.partial ? "Partial: collector or executors are still running." : "Completed attempt."}\n`,
    )
}
