import { mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { createIsolatedTestEnv } from "../src/env"
import {
  batchInvocation,
  batchShardCount,
  collectTests,
  relocateCoverage,
  shardMainFiles,
  splitBatchFiles,
} from "./batches"

export function executionBatches(files: string[], root: string, shards = 4) {
  const { main, isolated } = splitBatchFiles(files, root)
  return [
    ...shardMainFiles(main, shards).map((files, id) => ({ id, files, partition: id })),
    ...isolated.map((file, index) => ({
      id: shards + index,
      files: [file],
      partition: shardMainFiles([file], shards).findIndex((group) => group.length > 0),
    })),
  ].filter((batch) => batch.files.length > 0)
}

export async function runCoverageBatch(files: string[], shard: number, env: Record<string, string | undefined>) {
  return executeBatch(files, shard, process.cwd(), env, true)
}

async function executeBatch(
  files: string[],
  id: number,
  root: string,
  env: Record<string, string | undefined>,
  coverage: boolean,
) {
  const directory = path.join(root, "coverage/shards", String(id))
  await rm(directory, { recursive: true, force: true })
  await mkdir(directory, { recursive: true })
  const args = [
    "test",
    "--timeout",
    "30000",
    "--no-orphans",
    "--reporter=junit",
    `--reporter-outfile=${path.join(directory, "junit.xml")}`,
    ...(coverage ? ["--coverage", "--coverage-reporter=lcov", `--coverage-dir=${directory}`] : []),
    ...files,
  ]
  const invocation = batchInvocation(args, root)
  const started = Date.now()
  const child = Bun.spawn([process.execPath, ...invocation.args], {
    cwd: invocation.cwd,
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  const exitCode = await child.exited
  await Bun.write(
    path.join(directory, "timing.json"),
    JSON.stringify({ files, started, completed: Date.now(), seconds: (Date.now() - started) / 1000, exitCode }),
  )
  if (coverage && invocation.cwd !== root) {
    const report = Bun.file(path.join(directory, "lcov.info"))
    if (await report.exists()) await report.write(relocateCoverage(await report.text(), invocation.cwd, root))
  }
  return exitCode
}

export async function runTests(options: { coverage: boolean; root?: string; files?: string[] }) {
  const root = options.root ?? process.cwd()
  const shards = batchShardCount(process.env)
  const partition = process.env.SYNERGY_TEST_PARTITION
  const partitions = process.env.SYNERGY_TEST_PARTITIONS
  if (
    partition !== undefined &&
    (!/^\d+$/.test(partition) || Number(partition) >= shards || Number(partitions) !== shards)
  ) {
    throw new Error("Test partition must select one of the stable batch shards")
  }
  const inventory = (await collectTests("test", root)).toSorted()
  const files: string[] =
    options.files ?? (process.env.SYNERGY_TEST_FILES ? JSON.parse(process.env.SYNERGY_TEST_FILES) : inventory)
  if (!files.length || files.some((file) => !inventory.includes(file)))
    throw new Error("Unknown or empty test selection")
  const batches = executionBatches(files, root, shards).filter(
    (batch) => partition === undefined || batch.partition === Number(partition),
  )
  if (partition === undefined) await rm(path.join(root, "coverage/shards"), { recursive: true, force: true })
  const failures: number[] = []
  for (const batch of batches) {
    const isolated = await createIsolatedTestEnv()
    try {
      console.info(`Test batch ${batch.id}: ${batch.files.length} files`)
      const code = await executeBatch(batch.files, batch.id, root, isolated.env, options.coverage)
      if (code !== 0) failures.push(batch.id)
    } finally {
      await isolated.dispose()
    }
  }
  if (failures.length) console.error(`test batches failed: ${failures.join(", ")}`)
  return failures.length ? 1 : 0
}

if (import.meta.main) process.exitCode = await runTests({ coverage: process.argv.includes("--coverage") })
