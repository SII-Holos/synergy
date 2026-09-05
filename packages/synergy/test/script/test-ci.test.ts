import { describe, expect, test } from "bun:test"
import path from "node:path"
import { batchArgs, planShards, runSequentialShards, runBunTest } from "../../script/test-ci"
import { createIsolatedTestEnv } from "../../script/test-env"

describe("Synergy CI test runner", () => {
  test("builds explicit file-list batch arguments", () => {
    expect(batchArgs(["test/a.test.ts", "test/b.test.ts"], 2, 3)).toEqual([
      "test",
      "--timeout",
      "30000",
      "--no-orphans",
      "test/a.test.ts",
      "test/b.test.ts",
    ])
  })

  test("writes one JUnit report per shard when requested", () => {
    expect(batchArgs(["test/a.test.ts"], 2, 3, "coverage/ci-tests")).toEqual([
      "test",
      "--timeout",
      "30000",
      "--no-orphans",
      "test/a.test.ts",
      "--reporter=junit",
      `--reporter-outfile=${path.join("coverage/ci-tests", "synergy-test-shard-2-of-3.xml")}`,
    ])
  })

  test("planShards deals the main batch by hash and runs isolated files alone", () => {
    const plan = planShards(["test/a.test.ts", "test/b.test.ts", "test/vector/embedding-standalone.test.ts"])
    const flattened = plan.batches
      .map((batch) => batch.files)
      .flat()
      .toSorted()
    expect(flattened).toEqual(["test/a.test.ts", "test/b.test.ts", "test/vector/embedding-standalone.test.ts"])
    expect(plan.batches.map((batch) => batch.shard)).toEqual([1, 2, 3])
    const isolatedBatch = plan.batches.find((batch) => batch.files.includes("test/vector/embedding-standalone.test.ts"))
    expect(isolatedBatch?.files).toEqual(["test/vector/embedding-standalone.test.ts"])
  })

  test("planShards honors SYNERGY_BATCH_SHARDS", () => {
    const plan = planShards(["test/a.test.ts", "test/b.test.ts"], { SYNERGY_BATCH_SHARDS: "2" })
    expect(plan.batches).toHaveLength(2)
  })

  test("runs every shard sequentially", async () => {
    const calls: string[][] = []
    const plan = planShards(["test/a.test.ts", "test/b.test.ts"], { SYNERGY_BATCH_SHARDS: "2" })
    const exitCode = await runSequentialShards(plan, async (args) => {
      calls.push(args)
      return 0
    })

    expect(exitCode).toBe(0)
    expect(calls).toHaveLength(2)
    expect(calls[0]).toContain("test/a.test.ts")
    expect(calls[1]).toContain("test/b.test.ts")
  })

  test("stops after the first failing shard", async () => {
    const calls: string[][] = []
    const plan = planShards(["test/a.test.ts", "test/b.test.ts"], { SYNERGY_BATCH_SHARDS: "2" })
    const exitCode = await runSequentialShards(plan, async (args) => {
      calls.push(args)
      return calls.length === 2 ? 17 : 0
    })

    expect(exitCode).toBe(17)
    expect(calls).toHaveLength(2)
  })
})

describe("CI orchestrator isolation env", () => {
  test("runBunTest spawns with the injected isolated env and deletes SYNERGY_HOME", async () => {
    const calls: Array<{ args: string[]; env: Record<string, string | undefined> }> = []
    const originalSpawn = Bun.spawn
    // @ts-expect-error – test-only interception of Bun.spawn
    Bun.spawn = ((command: string[], options: { env?: Record<string, string | undefined> }) => {
      calls.push({ args: command, env: options.env ?? {} })
      return {
        exited: Promise.resolve(0),
        stdin: undefined,
        stdout: undefined,
        stderr: undefined,
      } as never
    }) as typeof Bun.spawn
    try {
      const isolated = await createIsolatedTestEnv()
      try {
        const exit = await runBunTest(["test", "test/a.test.ts"], isolated.env)
        expect(exit).toBe(0)
        expect(calls).toHaveLength(1)
        expect(calls[0]!.env["SYNERGY_TEST_HOME"]).toBe(isolated.env["SYNERGY_TEST_HOME"])
        expect("SYNERGY_HOME" in calls[0]!.env).toBe(false)
      } finally {
        await isolated.dispose()
      }
    } finally {
      Bun.spawn = originalSpawn
    }
  })
})
