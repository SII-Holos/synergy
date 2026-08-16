import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const DEFAULT_SHARD_COUNT = 4

export function shardArgs(
  shard: number,
  shardCount = DEFAULT_SHARD_COUNT,
  reporterDirectory?: string,
  coverageShardsDir?: string,
): string[] {
  if (!Number.isInteger(shardCount) || shardCount < 1) throw new Error("Shard count must be a positive integer.")
  if (!Number.isInteger(shard) || shard < 1 || shard > shardCount) {
    throw new Error(`Shard must be between 1 and ${shardCount}.`)
  }

  const args = ["test", "--timeout", "30000", "--no-orphans", `--shard=${shard}/${shardCount}`]
  // Coverage mode writes each shard into its own lcov file so the coverage
  // gate can merge them (Bun overwrites coverage/lcov.info per invocation).
  // Running the same sequential shards as the Test job keeps timing-sensitive
  // suites stable: a single full-process coverage run is flaky under load
  // while the sharded Test job is consistently green.
  if (coverageShardsDir) {
    args.push("--coverage", "--coverage-reporter=lcov", `--coverage-dir=${path.join(coverageShardsDir, String(shard))}`)
  }
  if (reporterDirectory) {
    args.push("--reporter=junit", `--reporter-outfile=${path.join(reporterDirectory, `synergy-test-shard-${shard}-of-${shardCount}.xml`)}`)
  }
  return args
}

export async function runSequentialShards(
  run: (args: string[]) => Promise<number>,
  shardCount = DEFAULT_SHARD_COUNT,
  reporterDirectory?: string,
  coverageShardsDir?: string,
): Promise<number> {
  for (let shard = 1; shard <= shardCount; shard++) {
    const args = shardArgs(shard, shardCount, reporterDirectory, coverageShardsDir)
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
  const coverage = process.argv.includes("--coverage")
  const coverageShardsDir = coverage ? path.join(packageRoot, "coverage", "shards") : undefined
  if (coverageShardsDir) {
    await fs.rm(coverageShardsDir, { recursive: true, force: true })
    await fs.mkdir(coverageShardsDir, { recursive: true })
  }
  const reporterDirectory = process.env["SYNERGY_TEST_JUNIT_DIR"]
  if (reporterDirectory) await fs.mkdir(path.resolve(packageRoot, reporterDirectory), { recursive: true })
  return runSequentialShards(runBunTest, DEFAULT_SHARD_COUNT, reporterDirectory, coverageShardsDir)
}

if (import.meta.main) process.exit(await main())
