import { expect, test } from "bun:test"
import { createPlan } from "../../script/ci/plan"
import {
  inputArtifact,
  latestExecutions,
  workflowExecutions,
  reconcileExecutions,
  type WorkflowJob,
} from "../../script/ci/github"

test("successful dependency evidence reconciles only the current running attempt, never failures or missing identities", () => {
  const running = { unit: "case", attempt: "2", status: "in_progress", conclusion: null }
  const success = { postgres: { result: "success" } }
  expect(reconcileExecutions(plan, [running], success, "2")).toEqual([
    { ...running, status: "completed", conclusion: "success" },
  ])
  expect(reconcileExecutions(plan, [running], success, "3")).toEqual([running])
  expect(reconcileExecutions(plan, [running], {}, "2")).toEqual([running])
  expect(reconcileExecutions(plan, [running], { postgres: { result: "failure" } }, "2")).toEqual([running])
  expect(reconcileExecutions(plan, [], success, "2")).toEqual([])
  for (const status of ["queued", "completed"]) {
    const failed = { ...running, status, conclusion: "failure" }
    expect(reconcileExecutions(plan, [failed], success, "2")).toEqual([failed])
  }
})

const plan = createPlan({
  base: "base",
  head: "head",
  sha: "tested",
  run: "42",
  mode: "full",
  changed: [],
  baseWorkspaces: [],
  headWorkspaces: [],
  tasks: [{ id: "case", kind: "postgres", pool: "postgres", owners: [], needs: [], seconds: 1 }],
})
const job: WorkflowJob = { name: "postgres (case)", run_attempt: 1, status: "completed", conclusion: "success" }

test("transient transport failures retry the same history; authorization errors fail immediately", async () => {
  const previous = { ...process.env }
  let calls = 0,
    status = 503
  const server = Bun.serve({
    port: 0,
    fetch() {
      calls++
      if (status === 401 || calls === 1) return new Response("", { status })
      return Response.json({ jobs: [job] })
    },
  })
  try {
    process.env.GITHUB_REPOSITORY = "fixture/repository"
    process.env.GH_TOKEN = "fixture-token"
    process.env.GITHUB_API_URL = server.url.origin
    expect(await workflowExecutions(plan)).toEqual([
      { unit: "case", attempt: "1", status: "completed", conclusion: "success" },
    ])
    expect(calls).toBe(2)
    calls = 0
    status = 401
    await expect(workflowExecutions(plan)).rejects.toThrow("HTTP 401")
    expect(calls).toBe(1)
  } finally {
    process.env = previous
    await server.stop(true)
  }
})

test("only the latest actual unit execution admits retained results", () => {
  const executions = latestExecutions(plan, [
    job,
    { ...job, run_attempt: 2, conclusion: "failure" },
    { ...job, name: "other (case)", run_attempt: 3 },
  ])
  expect(executions).toEqual([{ unit: "case", attempt: "2", status: "completed", conclusion: "failure" }])
})

test("partial reruns ignore copied completed jobs while preserving fresh failures and queued executions", () => {
  const original = {
    ...job,
    created_at: "2026-09-30T00:00:00Z",
    started_at: "2026-09-30T00:00:01Z",
    completed_at: "2026-09-30T00:01:00Z",
  }
  const copied = { ...original, run_attempt: 2, created_at: "2026-09-30T00:02:00Z" }
  expect(latestExecutions(plan, [original, copied])).toEqual([
    { unit: "case", attempt: "1", status: "completed", conclusion: "success" },
  ])
  for (const fresh of [
    { ...copied, started_at: "2026-09-30T00:02:01Z", completed_at: "2026-09-30T00:03:00Z", conclusion: "failure" },
    { ...copied, started_at: null, completed_at: null, status: "queued", conclusion: null },
  ]) {
    const result = latestExecutions(plan, [original, fresh])
    expect(result).toEqual([{ unit: "case", attempt: "2", status: fresh.status, conclusion: fresh.conclusion }])
  }
  const producer = { ...original, name: "Full distribution" }
  expect(
    inputArtifact(
      plan,
      "ci-distribution-full",
      producer.name,
      [producer, { ...copied, name: producer.name }],
      [{ name: "ci-distribution-full-1", expired: false }],
    ),
  ).toBe("ci-distribution-full-1")
})

test("input reuse follows the producer attempt and rejects failed or expired producers", () => {
  const producer = { ...job, name: "Full distribution" }
  const original = { name: "ci-distribution-full-1", expired: false }
  expect(inputArtifact(plan, "ci-distribution-full", producer.name, [producer], [original])).toBe(original.name)
  expect(
    inputArtifact(
      plan,
      "ci-distribution-full",
      producer.name,
      [producer, { ...producer, run_attempt: 2, status: "in_progress", conclusion: null }],
      [original],
    ),
  ).toBeUndefined()
  expect(() =>
    inputArtifact(plan, "ci-distribution-full", producer.name, [{ ...producer, conclusion: "failure" }], [original]),
  ).toThrow("producer failed")
  expect(() =>
    inputArtifact(plan, "ci-distribution-full", producer.name, [producer], [{ ...original, expired: true }]),
  ).toThrow("expired")
})

test("the final gate waits for completed metadata of the latest actual execution", async () => {
  const previous = { ...process.env }
  let reads = 0
  let conclusion = "success"
  const server = Bun.serve({
    port: 0,
    fetch() {
      reads++
      return Response.json({
        jobs: [
          job,
          {
            ...job,
            run_attempt: 2,
            status: reads === 1 ? "in_progress" : "completed",
            conclusion: reads === 1 ? null : conclusion,
          },
        ],
      })
    },
  })
  try {
    process.env.GITHUB_REPOSITORY = "fixture/repository"
    process.env.GH_TOKEN = "fixture-token"
    process.env.GITHUB_API_URL = server.url.origin
    for (conclusion of ["success", "failure"]) {
      reads = 0
      expect(await workflowExecutions(plan, { timeoutMs: 1000, pollMs: 0 })).toEqual([
        { unit: "case", attempt: "2", status: "completed", conclusion },
      ])
      expect(reads).toBe(2)
    }
    reads = 0
    expect(await workflowExecutions(plan, { timeoutMs: 0, pollMs: 0 })).toEqual([
      { unit: "case", attempt: "2", status: "in_progress", conclusion: null },
    ])
  } finally {
    process.env = previous
    await server.stop(true)
  }
})

test("workflow evidence reads every page of a large rerun history before admitting a result", async () => {
  const previous = { ...process.env }
  const original = {
    ...job,
    created_at: "2026-09-30T00:00:00Z",
    started_at: "2026-09-30T00:00:01Z",
    completed_at: "2026-09-30T00:01:00Z",
  }
  const history = [
    original,
    ...Array.from({ length: 130 }, () => ({
      ...original,
      run_attempt: 4,
      created_at: "2026-09-30T00:04:00Z",
    })),
    { ...job, run_attempt: 2, conclusion: "failure" },
  ]
  const pages: number[] = []
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      const size = Number(url.searchParams.get("per_page"))
      if (size > 50) return new Response("Server Error", { status: 502 })
      const page = Number(url.searchParams.get("page"))
      pages.push(page)
      return Response.json({ total_count: history.length, jobs: history.slice((page - 1) * size, page * size) })
    },
  })
  try {
    process.env.GITHUB_REPOSITORY = "fixture/repository"
    process.env.GH_TOKEN = "fixture-token"
    process.env.GITHUB_API_URL = server.url.origin
    expect(await workflowExecutions(plan, { timeoutMs: 1000, pollMs: 0 })).toEqual([
      { unit: "case", attempt: "2", status: "completed", conclusion: "failure" },
    ])
    expect(pages).toEqual([1, 2, 3])
  } finally {
    process.env = previous
    await server.stop(true)
  }
})
