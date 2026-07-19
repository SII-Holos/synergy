import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const DEFAULT_SHARD_COUNT = 4

export function shardArgs(shard: number, shardCount = DEFAULT_SHARD_COUNT, reporterDirectory?: string): string[] {
  if (!Number.isInteger(shardCount) || shardCount < 1) throw new Error("Shard count must be a positive integer.")
  if (!Number.isInteger(shard) || shard < 1 || shard > shardCount) {
    throw new Error(`Shard must be between 1 and ${shardCount}.`)
  }

  const args = ["test", "--timeout", "30000", "--no-orphans", `--shard=${shard}/${shardCount}`]
  if (!reporterDirectory) return args
  return [
    ...args,
    "--reporter=junit",
    `--reporter-outfile=${path.join(reporterDirectory, `synergy-test-shard-${shard}-of-${shardCount}.xml`)}`,
  ]
}

export async function runSequentialShards(
  run: (args: string[]) => Promise<number>,
  shardCount = DEFAULT_SHARD_COUNT,
  reporterDirectory?: string,
): Promise<number> {
  for (let shard = 1; shard <= shardCount; shard++) {
    const args = shardArgs(shard, shardCount, reporterDirectory)
    console.log(`\n=== Synergy test shard ${shard}/${shardCount} ===`)
    const exitCode = await run(args)
    if (exitCode !== 0) return exitCode
  }
  return 0
}

const packageRoot = fileURLToPath(new URL("..", import.meta.url))

async function runBunTest(args: string[]): Promise<number> {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: packageRoot,
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  return child.exited
}

async function main() {
  const reporterDirectory = process.env["SYNERGY_TEST_JUNIT_DIR"]
  if (reporterDirectory) await fs.mkdir(path.resolve(packageRoot, reporterDirectory), { recursive: true })
  return runSequentialShards(runBunTest, DEFAULT_SHARD_COUNT, reporterDirectory)
}

if (import.meta.main) process.exit(await main())
