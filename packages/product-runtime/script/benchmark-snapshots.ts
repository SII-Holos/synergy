import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"

const { values } = parseArgs({
  options: {
    sessions: { type: "string", default: "10" },
    files: { type: "string", default: "200" },
    rounds: { type: "string", default: "3" },
  },
})
const sessions = Number(values.sessions)
const files = Number(values.files)
const rounds = Number(values.rounds)
if (![sessions, files, rounds].every((value) => Number.isSafeInteger(value) && value > 0))
  throw new Error("Benchmark sizes must be positive integers")
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-snapshot-benchmark-"))
process.env.SYNERGY_HOME = path.join(temporary, "home")
process.env.SYNERGY_DISABLE_MODELS_FETCH = "true"
process.env.SYNERGY_DISABLE_DEFAULT_PLUGINS = "true"
process.env.SYNERGY_DISABLE_LSP_DOWNLOAD = "true"
process.env.SYNERGY_OBSERVABILITY_INLINE = "1"
const { Snapshot } = await import("@ericsanchezok/synergy-harness/session/snapshot")
const { SnapshotStore } = await import("@ericsanchezok/synergy-harness/session/snapshot-store")
const { SnapshotMaintenance } = await import("@ericsanchezok/synergy-harness/session/snapshot-maintenance")
const { SnapshotGit } = await import("@ericsanchezok/synergy-harness/session/snapshot-git")
const { Scope } = await import("@ericsanchezok/synergy-harness/scope")
const { ScopeContext } = await import("@ericsanchezok/synergy-harness/scope/context")
const { StoragePath } = await import("@ericsanchezok/synergy-harness/storage/path")

function p95(values: number[]) {
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]
}

async function run(backend: "legacy" | "shared") {
  const workspace = path.join(temporary, backend)
  await fs.mkdir(workspace)
  for (let index = 0; index < files; index++)
    await Bun.write(path.join(workspace, `file-${index}.txt`), `baseline ${index}\n`.repeat(100))
  const init = await SnapshotGit.run(["git", "init", workspace], temporary)
  if (init.exitCode) throw new Error(init.stderr)
  const commit = await SnapshotGit.run(
    [
      "git",
      "-c",
      "user.name=Snapshot Benchmark",
      "-c",
      "user.email=benchmark@example.invalid",
      "commit",
      "--allow-empty",
      "--no-gpg-sign",
      "-m",
      backend,
    ],
    workspace,
  )
  if (commit.exitCode) throw new Error(commit.stderr)
  const { scope } = await Scope.fromDirectory(workspace)
  const ids = Array.from({ length: sessions }, (_, index) => `benchmark-${index}`)
  const repositories =
    backend === "shared"
      ? [SnapshotStore.repository(scope.id)]
      : ids.map((id) => SnapshotStore.legacyRepository(scope.id, id))
  if (backend === "legacy") {
    for (const id of ids) {
      const repo = SnapshotStore.legacyRepository(scope.id, id)
      await fs.mkdir(path.dirname(repo), { recursive: true })
      const initialized = await SnapshotGit.run(["git", "init", "--bare", repo], workspace)
      if (initialized.exitCode) throw new Error(initialized.stderr)
      await SnapshotStore.write(StoragePath.snapshotOwner(scope.id, id), { version: 2, backend })
    }
  }
  async function usage() {
    let objects = 0
    const total = { bytes: 0, allocatedBytes: 0, files: 0 }
    for (const repo of repositories) {
      for await (const _ of SnapshotGit.lines(repo, ["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"]))
        objects++
      const stats = await SnapshotMaintenance.statistics(path.join(repo, "objects"))
      for (const key of ["bytes", "allocatedBytes", "files"] as const) total[key] += stats[key]
    }
    return { objects, ...total }
  }
  return ScopeContext.provide({
    scope,
    fn: async () => {
      const initial: number[] = []
      const later: number[] = []
      let firstTree = ""
      for (const id of ids) {
        const start = performance.now()
        const tree = await Snapshot.track(id)
        if (!tree) throw new Error("Snapshot capture failed")
        firstTree ||= tree
        initial.push(performance.now() - start)
      }
      const baseline = await usage()
      for (let round = 0; round < rounds; round++) {
        await Bun.write(path.join(workspace, "file-0.txt"), `changed ${round}\n`)
        await Promise.all(
          ids.map(async (id) => {
            const start = performance.now()
            if (!(await Snapshot.track(id))) throw new Error("Concurrent snapshot failed")
            later.push(performance.now() - start)
          }),
        )
      }
      const file = path.join(workspace, "file-0.txt")
      const start = performance.now()
      await Snapshot.revert([{ hash: firstTree, files: [file] }], ids[0])
      const restoreMs = performance.now() - start
      if ((await Bun.file(file).text()) !== "baseline 0\n".repeat(100)) throw new Error("Restored bytes differ")
      const final = await usage()
      const indexes = await SnapshotMaintenance.statistics(SnapshotStore.cache(scope.id))
      const metadata = await SnapshotMaintenance.statistics(SnapshotStore.root(scope.id))
      if (backend === "legacy") {
        for (const repo of repositories) {
          const stats = await SnapshotMaintenance.statistics(repo)
          for (const key of ["bytes", "allocatedBytes", "files"] as const) metadata[key] += stats[key]
          const index = await fs.stat(path.join(repo, "index"))
          indexes.bytes += index.size
          indexes.allocatedBytes += index.blocks * 512
          indexes.files++
        }
      }
      for (const key of ["bytes", "allocatedBytes", "files"] as const)
        metadata[key] -= final[key] + (backend === "legacy" ? indexes[key] : 0)
      return {
        backend,
        baseline,
        final,
        indexes,
        metadata,
        coldMs: initial[0],
        initialP95Ms: p95(initial),
        laterP95Ms: p95(later),
        restoreMs,
      }
    },
  })
}

try {
  const results = [await run("legacy"), await run("shared")]
  process.stdout.write(
    JSON.stringify(
      {
        sessions,
        files,
        rounds,
        platform: process.platform,
        git: (await SnapshotGit.run(["git", "--version"], temporary)).text.trim(),
        note: "Both storage backends use the current capture/lease pipeline; timings are not an old-binary comparison. Object usage excludes refs/indexes, which are reported separately.",
        results,
      },
      null,
      2,
    ) + "\n",
  )
} finally {
  await fs.rm(temporary, { recursive: true, force: true })
}
