import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { makePlan, execute, report, type Driver } from "../../script/acceptance/runner"
import { atomicJSON, digest, sealEvidence, type AcceptanceCase } from "../../script/acceptance/evidence"

const scenario: AcceptanceCase = {
  id: "fixture",
  units: ["D"],
  risk: "Uncovered runs look successful",
  preconditions: ["Disposable state"],
  actions: ["Write independent observations"],
  fault: "None",
  expected: ["Evidence is complete"],
  verification: "Read independent observations",
  live: false,
  barriers: ["observed"],
  factors: ["native", "sqlite"],
  checks: [{ evidence: "physical.json", pointer: ["effects"], equals: 1 }],
}
const source = "a".repeat(40)
async function setup(root: string) {
  const input = path.join(root, "artifact")
  await Bun.write(input, "immutable")
  return makePlan({
    source,
    directory: path.join(root, "run"),
    cases: [scenario],
    inputs: [{ name: "artifact", path: input }],
  })
}
const driver: Driver = async (context) => {
  await atomicJSON(path.join(context.directory, "physical.json"), { effects: 1 })
  await atomicJSON(path.join(context.directory, "product.json"), { done: true })
  await atomicJSON(path.join(context.directory, "transport.json"), { observed: true })
  return {
    status: "passed",
    model: "not-applicable",
    barriers: ["observed"],
    requests: [],
    evidence: await Promise.all([
      sealEvidence(context.directory, "physical.json", "external"),
      sealEvidence(context.directory, "product.json", "product"),
      sealEvidence(context.directory, "transport.json", "transport"),
    ]),
  }
}

test("a failed driver preserves sealed observed stages without turning partial progress into acceptance", async () => {
  await using tmp = await tmpdir()
  const plan = await setup(tmp.path)
  await execute(
    plan,
    {
      fixture: async (context) => {
        await atomicJSON(path.join(context.directory, "physical.json"), { effects: 1 })
        await context.checkpoint("observed", [{ path: "physical.json", kind: "external" }])
        throw new Error("Recovery failed after the observed effect")
      },
    },
    { source },
  )
  const result = await Bun.file(path.join(plan.directory, "cases/fixture/1/result.json")).json()
  expect(result.status).toBe("failed")
  expect(result.barriers).toEqual(["observed"])
  expect(result.evidence.some((entry: { path: string }) => entry.path === "physical.json")).toBe(true)
  expect((await report(plan)).passed).toBe(false)
  await Bun.write(path.join(plan.directory, "cases/fixture/1/physical.json"), '{"effects":2}')
  expect((await report(plan)).cases[0]!.errors).toContain("changed:physical.json")
})

test("a frozen run succeeds and resume never repeats a completed experiment", async () => {
  await using tmp = await tmpdir()
  const plan = await setup(tmp.path)
  let calls = 0
  const drivers = {
    fixture: async (context: Parameters<Driver>[0]) => {
      calls++
      return driver(context)
    },
  }
  await execute(plan, drivers, { source })
  expect((await report(plan)).passed).toBe(true)
  await execute(plan, drivers, { source, resume: true })
  expect(calls).toBe(1)
  await expect(execute(plan, drivers, { source })).rejects.toThrow("already started")
})

test("changing recorded provider bytes invalidates an otherwise passing experiment", async () => {
  await using tmp = await tmpdir()
  const plan = await setup(tmp.path)
  await execute(
    plan,
    {
      fixture: async (context) => {
        const directory = path.join(context.directory, "requests", "request")
        await atomicJSON(path.join(directory, "request.json"), {
          id: "request",
          status: "completed",
          usage: { input: 1, output: 1 },
        })
        await Bun.write(path.join(directory, "request.bin"), "request")
        await Bun.write(path.join(directory, "response.bin"), "response")
        return driver(context)
      },
    },
    { source },
  )
  expect((await report(plan)).passed).toBe(true)
  await Bun.write(path.join(plan.directory, "cases/fixture/1/requests/request/response.bin"), "changed")
  expect((await report(plan)).passed).toBe(false)
})

test("a missing result after controller death remains unknown and requires an explicit retry reason", async () => {
  await using tmp = await tmpdir()
  const plan = await setup(tmp.path)
  await atomicJSON(path.join(plan.directory, "cases/fixture/1/start.json"), { plan: plan.digest, started: 1 })
  const before = await report(plan)
  expect(before.passed).toBe(false)
  expect(before.cases[0]!.status).toBe("unknown")
  let calls = 0
  const drivers = {
    fixture: async (context: Parameters<Driver>[0]) => {
      calls++
      return driver(context)
    },
  }
  await execute(plan, drivers, { source, resume: true })
  expect(calls).toBe(0)
  await execute(plan, drivers, { source, resume: true, retry: ["fixture"], reason: "Investigated lost controller" })
  expect(calls).toBe(1)
  expect((await report(plan)).cases[0]!.attempts).toBe(2)
  expect(await Bun.file(path.join(plan.directory, "cases/fixture/1/start.json")).exists()).toBe(true)
})

test("changing a frozen input or source blocks execution before driver side effects", async () => {
  await using tmp = await tmpdir()
  const plan = await setup(tmp.path)
  await expect(execute(plan, { fixture: driver }, { source: "b".repeat(40) })).rejects.toThrow("source")
  await Bun.write(path.join(tmp.path, "artifact"), "changed")
  await expect(execute(plan, { fixture: driver }, { source })).rejects.toThrow("artifact")
  expect((await report(plan)).passed).toBe(false)
})

test("plans freeze Bun and reject a different executable before driver side effects", async () => {
  await using tmp = await tmpdir()
  const plan = await setup(tmp.path)
  expect(plan.inputs.find((entry) => entry.name === "runtime")?.sha256).toBe(
    digest(await Bun.file(process.execPath).bytes()),
  )
  const other = path.join(tmp.path, "other-bun")
  await Bun.write(other, "different executable")
  const mismatched = await makePlan({
    source,
    directory: path.join(tmp.path, "mismatched"),
    cases: [scenario],
    inputs: [{ name: "runtime", path: other }],
  })
  let executed = false
  await expect(
    execute(
      mismatched,
      {
        fixture: async (context) => {
          executed = true
          return driver(context)
        },
      },
      { source },
    ),
  ).rejects.toThrow("Running executable differs")
  expect(executed).toBe(false)
})

test("no driver, missing result and a modified result cannot be counted as passes", async () => {
  await using tmp = await tmpdir()
  const plan = await setup(tmp.path)
  await execute(plan, {}, { source })
  expect((await report(plan)).cases[0]!.status).toBe("uncovered")
  await execute(plan, { fixture: driver }, { source, resume: true, retry: ["fixture"], reason: "Driver is available" })
  expect((await report(plan)).passed).toBe(true)
  const file = path.join(plan.directory, "cases/fixture/2/result.json")
  const value = await Bun.file(file).json()
  value.plan = digest("foreign")
  await atomicJSON(file, value)
  expect((await report(plan)).passed).toBe(false)
  await fs.unlink(file)
  expect((await report(plan)).cases[0]!.status).toBe("unknown")
})

test("a concurrent runner cannot enter a run already held by another executor", async () => {
  await using tmp = await tmpdir()
  const plan = await setup(tmp.path)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const running = execute(
    plan,
    {
      fixture: async (context) => {
        entered.resolve()
        await release.promise
        return driver(context)
      },
    },
    { source },
  )
  await entered.promise
  try {
    await expect(execute(plan, { fixture: driver }, { source, resume: true })).rejects.toThrow("locked")
  } finally {
    release.resolve()
    await running
  }
})

test("paid requests remain in accounting when the scenario throws before producing a result", async () => {
  await using tmp = await tmpdir()
  const plan = await setup(tmp.path)
  await execute(
    plan,
    {
      fixture: async (context) => {
        await atomicJSON(path.join(context.directory, "requests/request-1/request.json"), {
          id: "request-1",
          status: "unknown",
          usage: null,
        })
        throw new Error("Controller failed")
      },
    },
    { source },
  )
  const result = await report(plan)
  expect(result.passed).toBe(false)
  expect(result.usage.requests).toBe(1)
  expect(result.usage.unknownUsage).toBe(1)
})
