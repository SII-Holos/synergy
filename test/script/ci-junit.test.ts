import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createPlan, type Task } from "../../script/ci/plan"
import { type TaskResult } from "../../script/ci/evidence"
import { verifyScenarios } from "../../script/ci/junit"

const prefix = "installed runtime artifact preserves "
const scenario = (id: string) => `${prefix}${id} outcome outside the repository`

async function fixture(body: string, expected = [scenario("read")], pattern?: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ci-junit-"))
  const report = path.join(root, "report.xml")
  try {
    const filename = path.join(root, "fixture.test.ts")
    await Bun.write(filename, `import { expect, test } from "bun:test";\n${body}`)
    const child = Bun.spawn(
      [
        process.execPath,
        "test",
        "--config",
        "/dev/null",
        "--reporter=junit",
        `--reporter-outfile=${report}`,
        ...(pattern ? ["--test-name-pattern", pattern] : []),
        filename,
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    )
    const [code] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    const task: Task = {
      id: "installed-control",
      kind: "artifacts",
      pool: "linux",
      owners: [],
      needs: [],
      seconds: 1,
      scenarios: expected,
      scenarioPrefix: prefix,
    }
    const plan = createPlan({
      base: "base",
      head: "head",
      sha: "tested",
      run: "fixture",
      mode: "full",
      changed: [],
      baseWorkspaces: [],
      headWorkspaces: [],
      tasks: [task],
    })
    const result: TaskResult = {
      version: 2,
      task: task.id,
      unit: plan.units.find((unit) => unit.tasks.includes(task.id))!.id,
      plan: plan.digest,
      sha: plan.sha,
      run: plan.run,
      planAttempt: plan.attempt,
      executionAttempt: plan.attempt,
      mode: plan.mode,
      status: "success",
      exitCode: 0,
      started: new Date().toISOString(),
      completed: new Date().toISOString(),
      reports: [{ path: "report.xml", sha256: "", kind: "junit" }],
      steps: [{ name: "control", seconds: 1, exitCode: 0 }],
    }
    async function seal() {
      result.reports[0]!.sha256 = createHash("sha256")
        .update(await Bun.file(report).bytes())
        .digest("hex")
    }
    await seal()
    return {
      root,
      report,
      plan,
      result,
      code,
      seal,
      verify: () => verifyScenarios(root, plan, [result]),
      [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }),
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

test("real Bun JUnit admits each requested scenario once and allows a separate watcher case", async () => {
  await using run = await fixture(
    `test(${JSON.stringify(scenario("read"))}, () => {}); test("native watcher", () => {});`,
  )
  expect(run.code).toBe(0)
  expect(await run.verify()).toEqual([])
})

test.each([
  ["missing", 'test("native watcher", () => {});', "Missing scenario"],
  ["skipped", `test.skip(${JSON.stringify(scenario("read"))}, () => {});`, "Scenario did not pass"],
  ["failed", `test(${JSON.stringify(scenario("read"))}, () => expect(false).toBe(true));`, "Scenario did not pass"],
  [
    "duplicate",
    `test(${JSON.stringify(scenario("read"))}, () => {}); test(${JSON.stringify(scenario("read"))}, () => {});`,
    "Duplicate scenario",
  ],
  [
    "unplanned",
    `test(${JSON.stringify(scenario("read"))}, () => {}); test(${JSON.stringify(scenario("tool"))}, () => {});`,
    "Unplanned scenario",
  ],
])("real Bun JUnit cannot admit %s scenario evidence", async (_label, body, error) => {
  await using run = await fixture(body!)
  expect((await run.verify()).some((message) => message.includes(error!))).toBe(true)
})

test("a real Bun filtered-out run cannot satisfy a selected scenario", async () => {
  await using run = await fixture(`test(${JSON.stringify(scenario("read"))}, () => {});`, undefined, "does-not-match")
  expect(run.code).toBe(1)
  expect((await run.verify()).some((message) => message.includes("Scenario did not pass"))).toBe(true)
})

test("an empty JUnit run cannot satisfy a selected scenario", async () => {
  await using run = await fixture(`test(${JSON.stringify(scenario("read"))}, () => {});`)
  await Bun.write(run.report, '<testsuites tests="0"/>')
  await run.seal()
  expect((await run.verify()).some((message) => message.includes("Missing scenario"))).toBe(true)
})

test.each([
  ["error", `<testsuites><testsuite><testcase name="${scenario("read")}"><error/></testcase></testsuite></testsuites>`],
  ["malformed", "<testsuites><testsuite>"],
])("JUnit %s content cannot satisfy a selected scenario", async (_label, xml) => {
  await using run = await fixture(`test(${JSON.stringify(scenario("read"))}, () => {});`)
  await Bun.write(run.report, xml!)
  await run.seal()
  expect((await run.verify()).length).toBeGreaterThan(0)
})

test("tampered report bytes are rejected before scenario parsing", async () => {
  await using run = await fixture(`test(${JSON.stringify(scenario("read"))}, () => {});`)
  await Bun.write(run.report, '<testsuites tests="0"/>')
  expect((await run.verify()).some((message) => message.includes("checksum"))).toBe(true)
})
