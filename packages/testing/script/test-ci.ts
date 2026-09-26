import path from "node:path"
import { runTests } from "./run"
import { batchInvocation, batchShardCount, collectTests, shardMainFiles, splitBatchFiles } from "./batches"

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
  const invocation = batchInvocation(args)
  const child = Bun.spawn([process.execPath, ...invocation.args], {
    cwd: invocation.cwd,
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  return child.exited
}

if (import.meta.main) process.exitCode = await runTests({ coverage: false })
