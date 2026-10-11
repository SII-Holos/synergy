import { expect, test } from "bun:test"
import {
  batchKey,
  batchKind,
  collectTimings,
  estimateBatch,
  recordTiming,
  timingProfile,
  validateTimings,
  type Timings,
} from "../../script/ci/timing"
import { buildUnits, createPlan, validatePlan, type Task } from "../../script/ci/plan"
import type { TaskResult } from "../../script/ci/evidence"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { suiteSeconds } from "../../script/ci/suites"

const profile = timingProfile("linux", "x64", "1.4.2")
const empty = (): Timings => ({ version: 1, profiles: {} })

test("browser weights follow a shared fixture while keeping ordinary isolated tests separate", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ci-browser-weight-"))
  try {
    await Bun.write(path.join(root, "test/browser.test.ts"), 'import { page } from "./support/browser"')
    await Bun.write(path.join(root, "test/support/browser.ts"), 'import { chromium } from "playwright"')
    await Bun.write(path.join(root, "test/unit.test.ts"), 'import { value } from "./support/value"')
    await Bun.write(path.join(root, "test/support/value.ts"), "export const value = 1")
    expect(batchKind(["test/browser.test.ts"], root)).toBe("browser")
    await Bun.write(path.join(root, "test/browser.test.ts"), 'import { page } from "./support/browser.ts"')
    expect(batchKind(["test/browser.test.ts"], root)).toBe("browser")
    expect(batchKind(["test/unit.test.ts"], root)).toBe("isolated")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test.each([
  [
    "apps/web",
    [
      "test/components/session/conversation-process.dom.test.ts",
      "test/components/session/conversation-process-disclosure.dom.test.ts",
      "test/components/session/conversation-process-reading.dom.test.ts",
      "test/components/session/conversation-process-virtualization.dom.test.ts",
    ],
  ],
  [
    "apps/web",
    [
      "test/components/workspace/workbench-surface.dom.test.ts",
      "test/components/session/decision-surface.dom.test.tsx",
    ],
  ],
  [
    "packages/ui",
    [
      "test/components/message-readers.render.test.ts",
      "test/components/execution-completion.dom.test.ts",
      "test/components/tool/computer-tool-renders.test.tsx",
      "test/components/basic-tool-lifecycle.dom.test.ts",
      "test/components/countdown-anchor.dom.test.ts",
      "test/components/message-part-error-boundary.test.ts",
    ],
  ],
] as const)("%s estimates the actual isolated frontend batches", async (owner, files) => {
  const profile = timingProfile("linux", "x64", Bun.version)
  const root = await mkdtemp(path.join(os.tmpdir(), "ci-frontend-batches-"))
  try {
    const timings = empty()
    for (const [index, file] of files.entries()) {
      await Bun.write(path.join(root, file), 'import { chromium } from "playwright"')
      recordTiming(timings, timingProfile("linux", "x64"), batchKey(owner, [file]), {
        owner,
        kind: "browser",
        files: [file],
        sample: { id: file, completed: new Date(0).toISOString(), seconds: index ? 90 : 1 },
      })
    }
    expect(suiteSeconds([...files], root, timings, owner)).toBe(1 + (files.length - 1) * 90)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("timing collection stays available on dependency-free verification workers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ci-timing-no-dependencies-"))
  try {
    await Bun.write(path.join(root, "timing.ts"), Bun.file(path.resolve(import.meta.dir, "../../script/ci/timing.ts")))
    await Bun.write(path.join(root, "input.json"), JSON.stringify(empty()))
    const child = Bun.spawn(
      [process.execPath, "--no-install", "timing.ts", "--input", "input.json", "--output", "output.json"],
      {
        cwd: root,
        env: { ...process.env, NODE_PATH: undefined },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    expect(await Bun.file(path.join(root, "output.json")).json()).toEqual(empty())
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("batch identity follows its files rather than its assigned partition", () => {
  expect(batchKey("apps/web", ["b", "a"])).toBe(batchKey("apps/web", ["a", "b"]))
  expect(batchKey("apps/web", ["a"])).not.toBe(batchKey("apps/web", ["b"]))
})

test("timings retain ten observations and react immediately to the latest slower batch", () => {
  const value = empty()
  for (let index = 0; index < 12; index++)
    recordTiming(value, profile, batchKey("apps/web", ["a"]), {
      owner: "apps/web",
      kind: "browser",
      files: ["a"],
      sample: { id: String(index), completed: new Date(index * 1000).toISOString(), seconds: index + 1 },
    })
  recordTiming(value, profile, batchKey("apps/web", ["a"]), {
    owner: "apps/web",
    kind: "browser",
    files: ["a"],
    sample: { id: "11", completed: new Date(11000).toISOString(), seconds: 12 },
  })
  expect(value.profiles[profile]![batchKey("apps/web", ["a"])]!.samples).toHaveLength(10)
  expect(estimateBatch(value, profile, "apps/web", ["a"], "browser")).toBe(12)
  expect(estimateBatch(value, profile, "apps/web", ["new"], "browser")).toBe(12)
  expect(estimateBatch(value, timingProfile("linux", "x64", "different"), "apps/web", ["a"], "browser")).toBe(30)
})

test("invalid measured times are rejected rather than becoming scheduling weights", () => {
  expect(() => validateTimings({ version: 2, profiles: {} })).toThrow()
  const value = empty()
  expect(() =>
    recordTiming(value, profile, "task:x", {
      owner: "x",
      kind: "task",
      sample: { id: "x", completed: "invalid", seconds: -1 },
    }),
  ).toThrow()
  expect(() =>
    recordTiming(value, profile, "batch:missing", {
      owner: "x",
      kind: "shared",
      sample: { id: "x", completed: new Date(0).toISOString(), seconds: 1 },
    }),
  ).toThrow()
})

test("execution units estimate two worker finish times rather than summing both lanes", () => {
  const tasks = [100, 99, 98, 97, 2, 2].map(
    (seconds, index): Task => ({
      id: String(index),
      kind: "benchmark-native",
      pool: "docker",
      seconds,
      owners: [],
      needs: [],
    }),
  )
  const units = buildUnits(tasks, "full")
  for (const unit of units) {
    const lanes = [0, 0]
    for (const id of unit.tasks) {
      lanes.sort((a, b) => a - b)
      lanes[0] += tasks.find((task) => task.id === id)!.seconds
    }
    expect(unit.seconds).toBe(Math.max(...lanes))
  }
  expect(Math.max(...units.map((unit) => unit.seconds))).toBeLessThanOrEqual(102)
})

test("admitted timings retain the executed platform and immutable plan snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ci-timing-results-"))
  try {
    const files = ["test/value.test.ts"]
    const tasks: Task[] = [
      {
        id: "suite",
        kind: "suite",
        pool: "linux",
        owners: ["apps/web"],
        package: "apps/web",
        needs: [],
        seconds: 1,
        files,
      },
    ]
    const plan = createPlan({
      base: "base",
      head: "head",
      sha: "tested",
      run: "fixture",
      mode: "full",
      changed: [],
      baseWorkspaces: [],
      headWorkspaces: [],
      tasks,
      timings: "snapshot",
    })
    expect(() => validatePlan({ ...plan, timings: "another snapshot" })).toThrow("identity changed")
    await Bun.write(path.join(root, "apps/web", files[0]!), 'import { chromium } from "playwright"')
    await Bun.write(path.join(root, "reports/batch.json"), JSON.stringify({ files, seconds: 41, exitCode: 0 }))
    const result: TaskResult = {
      version: 2,
      task: "suite",
      unit: plan.units[0]!.id,
      plan: plan.digest,
      sha: plan.sha,
      run: plan.run,
      planAttempt: plan.attempt,
      executionAttempt: "2",
      mode: "full",
      status: "success",
      exitCode: 0,
      started: "2026-10-04T00:00:00.000Z",
      completed: "2026-10-04T00:01:00.000Z",
      runtime: { platform: "linux", arch: "x64", bun: "1.4.2" },
      reports: [{ kind: "timing", path: "batch.json", sha256: "admitted" }],
      steps: [],
    }
    const snapshot = empty()
    const collected = await collectTimings(snapshot, root, path.join(root, "reports"), plan, [
      result,
      { ...result, status: "failure", runtime: { platform: "darwin", arch: "arm64", bun: "1.4.2" } },
      { ...result, runtime: undefined },
    ])
    expect(snapshot).toEqual(empty())
    expect(Object.keys(collected.profiles)).toEqual([profile])
    expect(estimateBatch(collected, profile, "apps/web", files, "browser")).toBe(41)
    expect(collected.profiles[profile]![batchKey("apps/web", files)]!.samples[0]!.id).toContain("fixture/2/suite/")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
