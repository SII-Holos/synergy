import path from "node:path"
import { cp, mkdir } from "node:fs/promises"
import { workspaces } from "./workspace-manifest"
import { collectTests, batchShardCount } from "../packages/testing/script/batches"
import { createIsolatedTestEnv } from "../packages/testing/src/env"
import { suiteBatches } from "./ci/suites"

export function stabilityOptions(input: { repeat?: string; seed?: string }) {
  const repeat = Number(input.repeat ?? "5"),
    seed = Number(input.seed ?? "1")
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 100) throw new Error("repeat must be between 1 and 100")
  if (!Number.isInteger(seed) || seed < 0 || seed + repeat > 2 ** 32)
    throw new Error("seed must be a uint32 with room for repeats")
  return { repeat, seed }
}

export function stabilityFiles(selected: string[], batches: Array<{ files: string[] }>, batch: boolean) {
  if (!selected.length) throw new Error("Stability requires explicit --test paths")
  if (selected.some((file) => !batches.some((entry) => entry.files.includes(file))))
    throw new Error("Unknown stability test")
  return [
    ...new Set(
      batch
        ? batches.filter((entry) => entry.files.some((file) => selected.includes(file))).flatMap((entry) => entry.files)
        : selected,
    ),
  ].sort()
}

export async function runStability(
  root: string,
  options: {
    tests: string[]
    repeat: number
    seed: number
    batch?: boolean
    name?: string
  },
) {
  const packages = workspaces(root)
  const groups = new Map<string, string[]>()
  for (const file of options.tests) {
    if (
      path.isAbsolute(file) ||
      file.split("/").includes("..") ||
      !/(?:^|\/)test\/.*\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)
    )
      throw new Error(`Unknown stability test: ${file}`)
    const owner = packages.find((pkg) => file.startsWith(pkg.directory + "/"))?.directory ?? "."
    if (owner === "." && !file.startsWith("test/")) throw new Error(`Unknown test owner: ${file}`)
    groups.set(owner, [...(groups.get(owner) ?? []), owner === "." ? file : file.slice(owner.length + 1)])
  }
  if (!groups.size) throw new Error("Stability requires explicit --test paths")
  const selections = await Promise.all(
    [...groups].map(async ([owner, selected]) => {
      const directory = path.join(root, owner)
      const inventory = await collectTests("test", directory)
      const pkg = packages.find((pkg) => pkg.directory === owner)
      const shards = Number(
        /SYNERGY_BATCH_SHARDS=(\d+)/.exec(pkg?.scripts?.["test:coverage"] ?? "")?.[1] ?? batchShardCount({}),
      )
      const batches =
        owner === "." ? inventory.map((file) => ({ files: [file] })) : suiteBatches(inventory, directory, owner, shards)
      return { owner, directory, files: stabilityFiles(selected, batches, options.batch ?? false) }
    }),
  )
  const output = path.join(root, ".artifacts/verify/stability", new Date().toISOString().replaceAll(":", "-"))
  await mkdir(output, { recursive: true })
  const results: Array<{
    owner: string
    files: string[]
    seed: number
    exitCode: number
    seconds: number
    log: string
  }> = []
  for (let iteration = 0; iteration < options.repeat; iteration++) {
    for (const selection of selections) {
      const seed = options.seed + iteration
      const destination = path.join(output, `${iteration}-${selection.owner.replaceAll("/", "-")}`)
      await mkdir(destination, { recursive: true })
      const isolated = await createIsolatedTestEnv()
      const started = performance.now()
      const args =
        selection.owner === "."
          ? [
              process.execPath,
              "test",
              "--config",
              "/dev/null",
              "--randomize",
              "--seed",
              String(seed),
              ...(options.name ? ["--test-name-pattern", options.name] : []),
              ...selection.files,
            ]
          : [
              process.execPath,
              ...(["apps/web", "packages/ui"].includes(selection.owner)
                ? ["run", "test"]
                : [path.join(root, "packages/testing/script/test-ci.ts")]),
            ]
      try {
        console.info(
          `Stability ${iteration + 1}/${options.repeat}: ${selection.owner}, seed ${seed}, ${selection.files.length} files`,
        )
        const child = Bun.spawn(args, {
          cwd: selection.directory,
          env: {
            ...isolated.env,
            SYNERGY_TEST_FILES: JSON.stringify(selection.files),
            SYNERGY_TEST_SEED: String(seed),
            ...(options.name ? { SYNERGY_TEST_NAME: options.name } : {}),
          },
          stdout: Bun.file(path.join(destination, "output.log")),
          stderr: Bun.file(path.join(destination, "error.log")),
        })
        const exitCode = await child.exited
        results.push({
          owner: selection.owner,
          files: selection.files,
          seed,
          exitCode,
          seconds: (performance.now() - started) / 1000,
          log: path.relative(root, destination),
        })
        if (selection.owner !== ".") {
          const reports = path.join(selection.directory, "coverage/shards")
          await cp(reports, path.join(destination, "reports"), { recursive: true })
        }
      } finally {
        try {
          await Bun.write(path.join(output, "report.json"), JSON.stringify({ options, results }, null, 2) + "\n")
        } finally {
          await isolated.dispose()
        }
      }
    }
  }
  console.info(
    `Stability: ${results.filter((result) => result.exitCode === 0).length}/${results.length} passed; ${path.relative(root, output)}`,
  )
  return results.every((result) => result.exitCode === 0)
}
