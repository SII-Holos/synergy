import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createIsolatedTestEnv } from "./test-env"
import { batchShardCount, collectTests, shardMainFiles, splitBatchFiles } from "./coverage-run"

const packageRoot = fileURLToPath(new URL("..", import.meta.url))

export interface ShardPlan {
  batches: Array<{ files: string[]; shard: number }>
  shardCount: number
}

/**
 * Batch plan shared with the coverage runner: the main batch is dealt by
 * stable file-name hash into batchShardCount sequential processes, then every
 * state- or load-sensitive suite in ISOLATED_BATCH_FILES runs alone. Bun's
 * native --shard cannot exclude files, which is how shared-singleton flakes
 * kept reaching the Test job, so the plan passes explicit file lists instead.
 */
export function planShards(files: string[], env: Record<string, string | undefined> = {}): ShardPlan {
  const { main, isolated } = splitBatchFiles(files)
  const batches: ShardPlan["batches"] = []
  for (const shardFiles of shardMainFiles(main, batchShardCount(env))) {
    if (shardFiles.length === 0) continue
    batches.push({ files: shardFiles, shard: batches.length + 1 })
  }
  for (const file of isolated) batches.push({ files: [file], shard: batches.length + 1 })
  return { batches, shardCount: batches.length }
}

export function batchArgs(files: string[], shard: number, shardCount: number, reporterDirectory?: string): string[] {
  if (!Number.isInteger(shardCount) || shardCount < 1) throw new Error("Shard count must be a positive integer.")
  if (!Number.isInteger(shard) || shard < 1 || shard > shardCount) {
    throw new Error(`Shard must be between 1 and ${shardCount}.`)
  }
  const args = ["test", "--timeout", "30000", "--no-orphans", ...files]
  if (!reporterDirectory) return args
  return [
    ...args,
    "--reporter=junit",
    `--reporter-outfile=${path.join(reporterDirectory, `synergy-test-shard-${shard}-of-${shardCount}.xml`)}`,
  ]
}

export async function runSequentialShards(
  plan: ShardPlan,
  run: (args: string[]) => Promise<number>,
  reporterDirectory?: string,
): Promise<number> {
  for (const { files, shard } of plan.batches) {
    const args = batchArgs(files, shard, plan.shardCount, reporterDirectory)
    console.log(`\n=== Synergy test shard ${shard}/${plan.shardCount} (${files.length} files) ===`)
    const exitCode = await run(args)
    if (exitCode !== 0) return exitCode
  }
  return 0
}

export async function runBunTest(args: string[], env: Record<string, string | undefined>): Promise<number> {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: packageRoot,
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  return child.exited
}

async function main() {
  const reporterDirectory = process.env["SYNERGY_TEST_JUNIT_DIR"]
  if (reporterDirectory) await fs.mkdir(path.resolve(packageRoot, reporterDirectory), { recursive: true })
  const isolated = await createIsolatedTestEnv()
  try {
    const files = (await collectTests("test")).toSorted()
    const plan = planShards(files, isolated.env)
    return await runSequentialShards(plan, (args) => runBunTest(args, isolated.env), reporterDirectory)
  } finally {
    await isolated.dispose()
  }
}

if (import.meta.main) process.exit(await main())
