import { expect, test } from "bun:test"
import { createPlan } from "../../script/ci/plan"
import { inputArtifact, latestExecutions, workflowExecutions, type WorkflowJob } from "../../script/ci/github"

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

test("only the latest actual unit execution admits retained results", () => {
  const executions = latestExecutions(plan, [
    job,
    { ...job, run_attempt: 2, conclusion: "failure" },
    { ...job, name: "other (case)", run_attempt: 3 },
  ])
  expect(executions).toEqual([{ unit: "case", attempt: "2", status: "completed", conclusion: "failure" }])
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
