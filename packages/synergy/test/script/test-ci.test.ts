import { describe, expect, test } from "bun:test"
import path from "node:path"
import { runSequentialShards, shardArgs } from "../../script/test-ci"

describe("Synergy CI test runner", () => {
  test("builds isolated Bun test shard arguments", () => {
    expect(shardArgs(2, 4)).toEqual(["test", "--timeout", "30000", "--no-orphans", "--shard=2/4"])
  })

  test("writes one JUnit report per shard when requested", () => {
    expect(shardArgs(2, 4, "coverage/ci-tests")).toEqual([
      "test",
      "--timeout",
      "30000",
      "--no-orphans",
      "--shard=2/4",
      "--reporter=junit",
      `--reporter-outfile=${path.join("coverage/ci-tests", "synergy-test-shard-2-of-4.xml")}`,
    ])
  })

  test("runs every shard sequentially", async () => {
    const calls: string[][] = []
    const exitCode = await runSequentialShards(async (args) => {
      calls.push(args)
      return 0
    }, 4)

    expect(exitCode).toBe(0)
    expect(calls.map((args) => args.at(-1))).toEqual(["--shard=1/4", "--shard=2/4", "--shard=3/4", "--shard=4/4"])
  })

  test("stops after the first failing shard", async () => {
    const calls: string[][] = []
    const exitCode = await runSequentialShards(async (args) => {
      calls.push(args)
      return calls.length === 2 ? 17 : 0
    }, 4)

    expect(exitCode).toBe(17)
    expect(calls.map((args) => args.at(-1))).toEqual(["--shard=1/4", "--shard=2/4"])
  })
})
