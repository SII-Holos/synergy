import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createIsolatedTestEnv } from "../../src/env"
import {
  batchShardCount,
  batchInvocation,
  relocateCoverage,
  collectTests,
  ISOLATED_BATCH_FILES,
  runBatches,
  shardMainFiles,
  splitBatchFiles,
} from "../../script/coverage-run"

describe("coverage batch splitting", () => {
  test("keeps every discovered file exactly once across batches", () => {
    const files = [
      "test/a.test.ts",
      "packages/library/test/vector/embedding-standalone.test.ts",
      "packages/presets/test/server/nav-global-routes.test.ts",
      "test/b.test.ts",
      "packages/media/test/tools/openai-image-gen.test.ts",
      "packages/connections/test/channel/svg-raster-standalone.test.ts",
    ]
    const { main, isolated } = splitBatchFiles(files)
    expect([...main, ...isolated].toSorted()).toEqual([...files].toSorted())
  })

  test("moves isolated files out of the main batch in canonical order", () => {
    const { main, isolated } = splitBatchFiles([
      "test/a.test.ts",
      "packages/library/test/vector/embedding-standalone.test.ts",
      "packages/presets/test/server/nav-global-routes.test.ts",
    ])
    expect(main).toEqual(["test/a.test.ts"])
    expect(isolated).toEqual([
      "packages/library/test/vector/embedding-standalone.test.ts",
      "packages/presets/test/server/nav-global-routes.test.ts",
    ])
  })

  test("isolated set is pinned to the known load- and state-sensitive files", () => {
    expect([...ISOLATED_BATCH_FILES].toSorted()).toEqual([
      "packages/cli/test/cli/data-home-command.test.ts",
      "packages/cli/test/cli/data-storage-command.test.ts",
      "packages/cli/test/cli/migration-command.test.ts",
      "packages/cli/test/cli/read-commands.test.ts",
      "packages/cli/test/cli/transcript-commands.test.ts",
      "packages/cli/test/daemon/lifecycle.test.ts",
      "packages/cli/test/daemon/observe.test.ts",
      "packages/cli/test/daemon/platform-services.test.ts",
      "packages/cli/test/daemon/service.test.ts",
      "packages/cli/test/daemon/spec.test.ts",
      "packages/cli/test/daemon/systemd.test.ts",
      "packages/connections/test/channel/clarus-assignment.test.ts",
      "packages/connections/test/channel/clarus-invite-accept.test.ts",
      "packages/connections/test/channel/feishu-provider.test.ts",
      "packages/connections/test/channel/host.test.ts",
      "packages/connections/test/channel/managed-project-ownership.test.ts",
      "packages/connections/test/channel/provider/github/api-transport.test.ts",
      "packages/connections/test/channel/svg-raster-standalone.test.ts",
      "packages/connections/test/email/imap.test.ts",
      "packages/connections/test/holos/legacy-data-migration.test.ts",
      "packages/connections/test/holos/mailbox.test.ts",
      "packages/connections/test/holos/runtime.test.ts",
      "packages/external-agents/test/external-agent/openclaw.test.ts",
      "packages/formatter/test/format/formatter.test.ts",
      "packages/harness/test/config/extensions-field.test.ts",
      "packages/harness/test/global/test-home-guard.test.ts",
      "packages/harness/test/lifecycle/runtime.test.ts",
      "packages/harness/test/migration/terminal-progress.test.ts",
      "packages/harness/test/provider/catalog-stability.test.ts",
      "packages/harness/test/session/retry.test.ts",
      "packages/harness/test/storage/storage-retry.test.ts",
      "packages/harness/test/storage/storage-silent-not-found.test.ts",
      "packages/library/test/database.test.ts",
      "packages/library/test/embedding-local.test.ts",
      "packages/library/test/embedding.test.ts",
      "packages/library/test/experience-recall.test.ts",
      "packages/library/test/experience-reencode.test.ts",
      "packages/library/test/vector/embedding-standalone.test.ts",
      "packages/local-runtime/test/file/watcher.test.ts",
      "packages/local-runtime/test/provider/proxy.test.ts",
      "packages/local-runtime/test/sandbox/helper-source.test.ts",
      "packages/local-runtime/test/tools/session-search.test.ts",
      "packages/lsp/test/lsp/owner-runtime.test.ts",
      "packages/mcp/test/mcp/owner-lifecycle.test.ts",
      "packages/media/test/tools/openai-image-gen.test.ts",
      "packages/plugin-host/test/plugin/tool-invocation.test.ts",
      "packages/presets/test/agent/agent.test.ts",
      "packages/presets/test/cli/daemon-entry.test.ts",
      "packages/presets/test/cli/data.test.ts",
      "packages/presets/test/cli/managed-sdk.test.ts",
      "packages/presets/test/cli/services.test.ts",
      "packages/presets/test/config/import.test.ts",
      "packages/presets/test/plugin/mcp-declarative-oauth.test.ts",
      "packages/presets/test/plugin/routes/plugin-registry-routes.test.ts",
      "packages/presets/test/project/worktree.test.ts",
      "packages/presets/test/server/nav-global-routes.test.ts",
      "packages/presets/test/server/plugin-official-install.test.ts",
      "packages/presets/test/server/resident-runtime.test.ts",
      "packages/presets/test/server/runtime-handle.test.ts",
      "packages/presets/test/server/skill-route.test.ts",
      "packages/presets/test/server/storage-unavailable-escalation.test.ts",
      "packages/presets/test/tool/auto-expand.test.ts",
      "packages/workbench/test/stats/engine.test.ts",
    ])
  })
})

describe("main batch sharding", () => {
  test("Runtime-owning suites receive only the isolation preload and cannot share a batch", () => {
    const root = path.resolve(import.meta.dir, "../../..")
    const owner = path.join(root, "cli")
    const file = "test/cli/data-storage-command.test.ts"
    expect(batchInvocation(["test", file, "--reporter-outfile=reports/test.xml"], owner)).toEqual({
      args: ["test", path.join(owner, file), `--reporter-outfile=${path.join(owner, "reports/test.xml")}`],
      cwd: path.join(root, "testing"),
    })
    expect(() => batchInvocation(["test", file, "test/other.test.ts"], owner)).toThrow("own batch")
  })

  test("coverage relocation preserves counts and attributes paths to the original package", () => {
    const root = path.resolve(import.meta.dir, "../../..")
    const source = "SF:../cli/src/command.ts\nDA:1,3\nend_of_record\nSF:src/env.ts\nDA:2,5\nend_of_record\n"
    expect(relocateCoverage(source, path.join(root, "testing"), path.join(root, "cli"))).toBe(
      "SF:src/command.ts\nDA:1,3\nend_of_record\nSF:../testing/src/env.ts\nDA:2,5\nend_of_record\n",
    )
  })
  test("batchShardCount reads SYNERGY_BATCH_SHARDS and defaults to 4", () => {
    expect(batchShardCount({})).toBe(4)
    expect(batchShardCount({ SYNERGY_BATCH_SHARDS: "6" })).toBe(6)
    expect(batchShardCount({ SYNERGY_BATCH_SHARDS: "" })).toBe(4)
    expect(batchShardCount({ SYNERGY_BATCH_SHARDS: "nope" })).toBe(4)
    expect(batchShardCount({ SYNERGY_BATCH_SHARDS: "0" })).toBe(4)
  })

  test("shardMainFiles assigns shards by file-name hash, not batch position", () => {
    const full = shardMainFiles(["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"], 4)
    const withoutFirst = shardMainFiles(["test/b.test.ts", "test/c.test.ts"], 4)
    const shardOf = (shards: string[][], file: string) => shards.findIndex((shard) => shard.includes(file))
    expect(shardOf(withoutFirst, "test/b.test.ts")).toBe(shardOf(full, "test/b.test.ts"))
    expect(shardOf(withoutFirst, "test/c.test.ts")).toBe(shardOf(full, "test/c.test.ts"))
  })

  test("shardMainFiles keeps every file exactly once across shards, deterministically", () => {
    const files = ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts", "test/d.test.ts", "test/e.test.ts"]
    const shards = shardMainFiles(files, 2)
    expect(shards.flat().toSorted()).toEqual(files.toSorted())
    expect(shardMainFiles(files, 2)).toEqual(shards)
  })

  test("shardMainFiles tolerates more shards than files", () => {
    const shards = shardMainFiles(["a.test.ts"], 3)
    expect(shards).toHaveLength(3)
    expect(shards.flat()).toEqual(["a.test.ts"])
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
          ["test/a.test.ts", "packages/library/test/vector/embedding-standalone.test.ts"],
          { SYNERGY_BATCH_SHARDS: "1" },
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
      ["test/a.test.ts", "test/b.test.ts", "packages/library/test/vector/embedding-standalone.test.ts"],
      { SYNERGY_BATCH_SHARDS: "2" },
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
    await runBatches(["test/a.test.ts", "test/b.test.ts"], { SYNERGY_BATCH_SHARDS: "4" }, recording)
    expect(shards).toEqual([0, 1])
  })
})

describe("workspace test ownership", () => {
  test("discovers nested tests only in the selected package", async () => {
    const isolated = await createIsolatedTestEnv()
    try {
      const root = isolated.env.SYNERGY_TEST_ROOT!
      await Bun.write(path.join(root, "test/domain/nested.test.ts"), "")
      await Bun.write(path.join(root, "test/view.spec.tsx"), "")
      await Bun.write(path.join(root, "test/fixture.ts"), "")
      expect((await collectTests("test", root)).toSorted()).toEqual([
        "test/domain/nested.test.ts",
        "test/view.spec.tsx",
      ])
    } finally {
      await isolated.dispose()
    }
  })

  test("resolves isolation rules against package ownership after relocation", () => {
    const library = path.resolve(import.meta.dir, "../../../library")
    const files = ["test/database.test.ts", "test/intent.test.ts"]
    expect(splitBatchFiles(files, library)).toEqual({
      main: ["test/intent.test.ts"],
      isolated: ["test/database.test.ts"],
    })
  })

  test("every isolation rule still names an existing suite", async () => {
    const root = path.resolve(import.meta.dir, "../../../..")
    const missing: string[] = []
    for (const file of ISOLATED_BATCH_FILES) {
      if (!(await fs.stat(path.join(root, file)).catch(() => undefined))) missing.push(file)
    }
    expect(missing).toEqual([])
  })
})
