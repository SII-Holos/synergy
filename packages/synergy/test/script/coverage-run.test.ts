import { describe, expect, test } from "bun:test"
import { ISOLATED_COVERAGE_FILES, splitCoverageBatches, runBatches } from "../../script/coverage-run"

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

  test("isolated set is pinned to the known load-sensitive files", () => {
    expect([...ISOLATED_COVERAGE_FILES].toSorted()).toEqual([
      "test/channel/svg-raster-standalone.test.ts",
      "test/config/import.test.ts",
      "test/holos/runtime.test.ts",
      "test/plugin/mcp-declarative-oauth.test.ts",
      "test/provider/catalog-stability.test.ts",
      "test/provider/proxy.test.ts",
      "test/server/nav-global-routes.test.ts",
      "test/server/plugin-official-install.test.ts",
      "test/server/plugin-registry-routes.test.ts",
      "test/session/retry.test.ts",
      "test/tool/arxiv-download.test.ts",
      "test/tool/openai-image-gen.test.ts",
      "test/vector/embedding-standalone.test.ts",
    ])
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
      expect(await runBatches(["test/a.test.ts", "test/vector/embedding-standalone.test.ts"], env, fail)).toBe(1)
    } finally {
      console.error = originalError
    }
    const message = errors.join("\n")
    expect(message).toContain("shard 0")
    expect(message).toContain("shard 1")
  })

  test("runs the main batch first, then isolated batches", async () => {
    const calls: Array<{ shard: number; files: number }> = []
    const recording: (
      files: string[],
      shard: number,
      env: Record<string, string | undefined>,
    ) => Promise<number> = async (files, shard) => {
      calls.push({ shard, files: files.length })
      return 0
    }
    await runBatches(["test/a.test.ts", "test/b.test.ts", "test/vector/embedding-standalone.test.ts"], env, recording)
    expect(calls).toEqual([
      { shard: 0, files: 2 },
      { shard: 1, files: 1 },
    ])
  })
})
