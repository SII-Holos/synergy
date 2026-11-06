import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { Snapshot } from "../../src/session/snapshot"
import { SnapshotLive } from "../../src/session/snapshot-live"
import { SnapshotStore } from "../../src/session/snapshot-store"
import { SnapshotGit } from "../../src/session/snapshot-git"
import { ScopeContext } from "../../src/scope/context"
import { ObservabilityMetrics } from "../../src/observability/metrics"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"

test.skipIf(process.env.SYNERGY_LIVE_BENCHMARK !== "1")(
  "reports live capture and comparison cost on 14000 real source files",
  async () => {
    await using runtime = await testRuntime()
    const root = path.resolve(import.meta.dir, "../../../..")
    const child = Bun.spawn(["git", "ls-files", "-z"], { cwd: root, stdout: "pipe" })
    const names = (await new Response(child.stdout).text())
      .split("\0")
      .filter((name) => /\.(?:ts|tsx|js|css|md|json)$/.test(name))
    expect(await child.exited).toBe(0)
    const corpus: Array<{ name: string; bytes: Buffer }> = []
    const digest = createHash("sha256")
    for (const name of names) {
      const bytes = await fs.readFile(path.join(root, name))
      if (bytes.length > 256 * 1024) continue
      corpus.push({ name, bytes })
      digest.update(name).update(bytes)
    }
    const files = Array.from({ length: 14000 }, (_, i) => ({
      name: `source/${Math.floor(i / 64)}/${i}${path.extname(corpus[i % corpus.length]!.name)}`,
      bytes: corpus[i % corpus.length]!.bytes,
    }))
    console.log(
      JSON.stringify({
        corpus: digest.digest("hex"),
        sourceFiles: corpus.length,
        files: files.length,
        bytes: files.reduce((sum, file) => sum + file.bytes.length, 0),
      }),
    )
    await runtime.run(async () => {
      await using directory = await tmpdir()
      for (let offset = 0; offset < files.length; offset += 64)
        await Promise.all(
          files.slice(offset, offset + 64).map((file) => Bun.write(path.join(directory.path, file.name), file.bytes)),
        )
      await ScopeContext.provide({
        scope: await directory.scope(),
        async fn() {
          const sessionID = "live-benchmark"
          const from = (await Snapshot.track(sessionID))!
          expect(from).toBeDefined()
          const live = await SnapshotLive.create(sessionID, from)
          try {
            await live.refresh([])
            const baselinePacks = await fs.readdir(
              path.join(SnapshotStore.repository(ScopeContext.current.scope.id), "objects/pack"),
            )
            const git = SnapshotGit.run
            let commands = 0
            using measured = spyOn(SnapshotGit, "run").mockImplementation((...args) => {
              commands++
              return git(...args)
            })
            const measure = async (scenario: string, iteration: number, paths: string[], full = false) => {
              let bytes = 0
              commands = 0
              const cpu = globalThis.process.cpuUsage(),
                start = performance.now()
              let count = 0
              await ObservabilityMetrics.withForwarder(
                (metric) => {
                  if (metric.name === "snapshot.capture.read.bytes") bytes += metric.value
                },
                async () => {
                  if (full) {
                    const to = (await Snapshot.track(sessionID))!
                    count = (await Snapshot.statistics(from, to, sessionID)).length
                  } else {
                    const revision = await live.refresh(paths)
                    count = (await Snapshot.liveStatistics(sessionID, revision)).length
                  }
                },
              )
              const usage = globalThis.process.cpuUsage(cpu)
              const sample = {
                scenario,
                iteration,
                ms: performance.now() - start,
                cpuMs: (usage.user + usage.system) / 1000,
                bytes,
                commands,
                count,
                rssMiB: globalThis.process.memoryUsage().rss / 1048576,
                objects: await live.retainedObjects(),
              }
              console.log(JSON.stringify(sample))
              return sample
            }
            const samples: Awaited<ReturnType<typeof measure>>[] = []
            const target = files[0]!
            for (let i = 0; i < 20; i++) {
              await Bun.write(
                path.join(directory.path, target.name),
                Buffer.concat([target.bytes, Buffer.from(`\nconst benchmarkIteration = ${i}\n`)]),
              )
              samples.push(await measure("single-dirty", i, [target.name]))
            }
            await Promise.all(
              files
                .slice(1, 4096)
                .map((file) =>
                  Bun.write(
                    path.join(directory.path, file.name),
                    Buffer.concat([file.bytes, Buffer.from("\n// benchmark change\n")]),
                  ),
                ),
            )
            samples.push(
              await measure(
                "burst-4095",
                0,
                files.slice(1, 4096).map((file) => file.name),
              ),
            )
            for (let i = 0; i < 20; i++) {
              await Bun.write(
                path.join(directory.path, target.name),
                Buffer.concat([target.bytes, Buffer.from(`\nconst benchmarkIteration = ${i + 20}\n`)]),
              )
              samples.push(await measure("4096-net-single-dirty", i, [target.name]))
            }
            expect(
              await fs.readdir(path.join(SnapshotStore.repository(ScopeContext.current.scope.id), "objects/pack")),
            ).toEqual(baselinePacks)
            for (let i = 0; i < 5; i++) samples.push(await measure("full-capture-comparison", i, [], true))
            for (const scenario of new Set(samples.map((sample) => sample.scenario))) {
              const sorted = samples.filter((sample) => sample.scenario === scenario).sort((a, b) => a.ms - b.ms)
              console.log(
                JSON.stringify({
                  summary: scenario,
                  runs: sorted.length,
                  p50: sorted[Math.floor(sorted.length * 0.5)]!.ms,
                  p95: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!.ms,
                  readBytes: sorted[0]!.bytes,
                  commands: sorted[0]!.commands,
                }),
              )
            }
          } finally {
            await live.close()
          }
        },
      })
    })
  },
  300_000,
)
