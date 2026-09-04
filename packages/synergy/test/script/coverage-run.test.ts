import { describe, expect, test } from "bun:test"
import {
  coverageShardCount,
  ISOLATED_COVERAGE_FILES,
  runBatches,
  shardMainFiles,
  splitCoverageBatches,
} from "../../script/coverage-run"

describe("coverage batch splitting", () => {
  test("keeps every discovered file exactly once across batches", () => {
    const files = [
      "test/a.test.ts",
      "test/vector/embedding-standalone.test.ts",
      "test/server/nav-global-routes.test.ts",
      "test/b.test.ts",
      "test/tool/openai-image-gen.test.ts",
      "test/channel/svg-raster-standalone.test.ts",
    ]
    const { main, isolated } = splitCoverageBatches(files)
    expect([...main, ...isolated].toSorted()).toEqual([...files].toSorted())
  })

  test("moves isolated files out of the main batch in canonical order", () => {
    const { main, isolated } = splitCoverageBatches([
      "test/a.test.ts",
      "test/vector/embedding-standalone.test.ts",
      "test/server/nav-global-routes.test.ts",
    ])
    expect(main).toEqual(["test/a.test.ts"])
    expect(isolated).toEqual(["test/vector/embedding-standalone.test.ts", "test/server/nav-global-routes.test.ts"])
  })

  test("isolated set is pinned to the known load- and state-sensitive files", () => {
    expect([...ISOLATED_COVERAGE_FILES].toSorted()).toEqual([
      "test/channel/clarus-invite-accept.test.ts",
      "test/channel/feishu-provider.test.ts",
      "test/channel/host.test.ts",
      "test/channel/managed-project-ownership.test.ts",
      "test/channel/svg-raster-standalone.test.ts",
      "test/config/import.test.ts",
      "test/email/imap.test.ts",
      "test/holos/runtime.test.ts",
      "test/library/database.test.ts",
      "test/library/embedding-local.test.ts",
      "test/library/embedding.test.ts",
      "test/library/experience-recall.test.ts",
      "test/plugin/mcp-declarative-oauth.test.ts",
      "test/provider/catalog-stability.test.ts",
      "test/provider/proxy.test.ts",
      "test/server/nav-global-routes.test.ts",
      "test/server/plugin-official-install.test.ts",
      "test/server/plugin-registry-routes.test.ts",
      "test/server/skill-route.test.ts",
      "test/session/retry.test.ts",
      "test/storage/storage-retry.test.ts",
      "test/tool/auto-expand.test.ts",
      "test/tool/openai-image-gen.test.ts",
      "test/vector/embedding-standalone.test.ts",
    ])
  })
})

describe("main batch sharding", () => {
  test("coverageShardCount reads SYNERGY_COVERAGE_SHARDS and defaults to 4", () => {
    expect(coverageShardCount({})).toBe(4)
    expect(coverageShardCount({ SYNERGY_COVERAGE_SHARDS: "6" })).toBe(6)
    expect(coverageShardCount({ SYNERGY_COVERAGE_SHARDS: "" })).toBe(4)
    expect(coverageShardCount({ SYNERGY_COVERAGE_SHARDS: "nope" })).toBe(4)
    expect(coverageShardCount({ SYNERGY_COVERAGE_SHARDS: "0" })).toBe(4)
  })

  test("shardMainFiles deals files round-robin so adjacent files never share a shard", () => {
    expect(shardMainFiles(["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts", "e.test.ts"], 2)).toEqual([
      ["a.test.ts", "c.test.ts", "e.test.ts"],
      ["b.test.ts", "d.test.ts"],
    ])
  })

  test("shardMainFiles tolerates more shards than files", () => {
    expect(shardMainFiles(["a.test.ts"], 3)).toEqual([["a.test.ts"], [], []])
  })
})

describe("runBatches failure reporting", () => {
  const env: Record<string, string | undefined> = {}
  const pass: (files: string[], shard: number, env: Record<string, string | undefined>) => Promise<number> = async () =>
    0
  const fail: (files: string[], shard: number, env: Record<string, string | undefined>) => Promise<number> = async () =>
    1

  test("returns 0 when every batch passes", async () => {
    expect(await runBatches(["test/a.test.ts"], env, pass)).toBe(0)
  })

  test("reports failures as a return code (not process.exit) so the caller's dispose still runs", async () => {
    const originalError = console.error
    const errors: string[] = []
    console.error = ((...args: unknown[]) => {
      errors.push(args.map(String).join(" "))
    }) as typeof console.error
    try {
      expect(
        await runBatches(
          ["test/a.test.ts", "test/vector/embedding-standalone.test.ts"],
          { SYNERGY_COVERAGE_SHARDS: "1" },
          fail,
        ),
      ).toBe(1)
    } finally {
      console.error = originalError
    }
    const message = errors.join("\n")
    expect(message).toContain("shard 0")
    expect(message).toContain("shard 1")
  })

  test("runs every main shard first, then isolated batches", async () => {
    const calls: Array<{ shard: number; files: number }> = []
    const recording: (
      files: string[],
      shard: number,
      env: Record<string, string | undefined>,
    ) => Promise<number> = async (files, shard) => {
      calls.push({ shard, files: files.length })
      return 0
    }
    await runBatches(
      ["test/a.test.ts", "test/b.test.ts", "test/vector/embedding-standalone.test.ts"],
      { SYNERGY_COVERAGE_SHARDS: "2" },
      recording,
    )
    expect(calls).toEqual([
      { shard: 0, files: 1 },
      { shard: 1, files: 1 },
      { shard: 2, files: 1 },
    ])
  })

  test("never spawns a batch for an empty shard", async () => {
    const shards: number[] = []
    const recording: (
      files: string[],
      shard: number,
      env: Record<string, string | undefined>,
    ) => Promise<number> = async (files, shard) => {
      shards.push(shard)
      return 0
    }
    await runBatches(["test/a.test.ts", "test/b.test.ts"], { SYNERGY_COVERAGE_SHARDS: "4" }, recording)
    expect(shards).toEqual([0, 1])
  })
})
