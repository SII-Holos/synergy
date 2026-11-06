import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { Snapshot } from "../../src/session/snapshot"
import { SnapshotStore } from "../../src/session/snapshot-store"
import { ScopeContext } from "../../src/scope/context"
import { ObservabilityMetrics } from "../../src/observability/metrics"
import { SessionFileChanges } from "../../src/session/file-changes"
import { Session } from "../../src/session"
import { Identifier } from "../../src/id/id"
import { MessageV2 } from "../../src/session/message-v2"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"

type Sample = {
  ms: number
  parentCpuMs: number
  parentRssMiB: number
  packCount: number
  objectKiB: number
  success: boolean
}
const root = path.resolve(import.meta.dir, "../../../..")
const excluded =
  /(^|\/)(\.git|\.synergy|node_modules|dist|build|target|\.next|\.nuxt|\.cache|coverage)(\/|$)|\.(zip|7z|rar|tar|gz|tgz|bz2|xz|db|sqlite|sqlite3|pdf|png|jpg|jpeg|gif|webp|mp3|mp4|mov|avi|mkv|bin|exe|dll|dylib|so|lock)$/i

async function command(args: string[]) {
  const child = Bun.spawn(args, { cwd: root, stdout: "pipe", stderr: "pipe" })
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(error)
  return output
}

test.skipIf(process.env.SYNERGY_SNAPSHOT_BENCHMARK !== "1")(
  "reports complete snapshot latency with logical cold and warm CAS fixtures",
  async () => {
    const runtime = await testRuntime()
    const revision = process.env.SYNERGY_SNAPSHOT_BENCHMARK_BASE
    const baselineFiles: string[] = []
    let track = Snapshot.track
    try {
      if (revision) {
        const suffix = crypto.randomUUID()
        const directory = path.join(root, "packages/harness/.artifacts", `snapshot-baseline-${suffix}`)
        await fs.mkdir(directory, { recursive: true })
        const capture = path.join(directory, `benchmark-capture-${suffix}.ts`)
        const snapshot = path.join(directory, `benchmark-snapshot-${suffix}.ts`)
        baselineFiles.push(directory)
        const relocate = (source: string, filename: string) =>
          source.replace(
            /(from\s+|import\()["'](\.{1,2}\/[^"']+)["']/g,
            (_, prefix: string, specifier: string) =>
              `${prefix}${JSON.stringify(specifier === "./snapshot-capture" ? capture : path.resolve(root, "packages/harness/src/session", path.dirname(filename), specifier))}`,
          )
        await fs.writeFile(
          capture,
          relocate(
            await command(["git", "show", `${revision}:packages/harness/src/session/snapshot-capture.ts`]),
            "snapshot-capture.ts",
          ),
        )
        await fs.writeFile(
          snapshot,
          relocate(
            await command(["git", "show", `${revision}:packages/harness/src/session/snapshot.ts`]),
            "snapshot.ts",
          ),
        )
        track = ((await import(snapshot)) as { Snapshot: typeof Snapshot }).Snapshot.track
      }
      const source = process.env.SYNERGY_SNAPSHOT_BENCHMARK_CORPUS ?? root
      const filenames =
        source === root
          ? (await command(["git", "ls-files", "-z"])).split("\0").filter((file) => file && !excluded.test(file))
          : (JSON.parse(await fs.readFile(path.join(source, "manifest.json"), "utf8")) as string[])
      const corpus: Array<{ name: string; bytes: Buffer }> = []
      for (const name of filenames) {
        const stat = await fs.lstat(path.join(source, name))
        if (stat.isFile() && stat.size <= 2 * 1024 * 1024)
          corpus.push({ name, bytes: await fs.readFile(path.join(source, name)) })
      }
      const digest = createHash("sha256")
      for (const file of corpus) digest.update(file.name).update("\0").update(file.bytes)
      const layout = process.env.SYNERGY_SNAPSHOT_BENCHMARK_LAYOUT ?? "clustered"
      console.log(
        JSON.stringify({
          benchmark: "snapshot",
          implementation: revision ? "baseline" : "streamed",
          corpus: digest.digest("hex"),
          files: corpus.length,
          bytes: corpus.reduce((sum, file) => sum + file.bytes.length, 0),
          bun: Bun.version,
          git: (await command(["git", "--version"])).trim(),
          platform: process.platform,
          layout,
        }),
      )
      const iterations = Number(process.env.SYNERGY_SNAPSHOT_BENCHMARK_RUNS ?? 20)
      const sizes = (process.env.SYNERGY_SNAPSHOT_BENCHMARK_SIZES ?? "7800,14000").split(",").map(Number)
      const cases = (
        process.env.SYNERGY_SNAPSHOT_BENCHMARK_CASES ??
        "cold,same,new-session,changed-1,changed-64,changed-65,changed-all,segment"
      ).split(",")
      await runtime.run(async () => {
        for (const size of sizes) {
          const data = Array.from({ length: size }, (_, index) => {
            const file = corpus[index % corpus.length]!
            return index < corpus.length
              ? file
              : {
                  name: `extra/${layout === "per-file" ? index : Math.floor(index / 64)}/${index}-${path.basename(file.name)}`,
                  bytes: Buffer.concat([Buffer.from(`fixture ${index}\n`), file.bytes]),
                }
          })
          for (const scenario of cases) {
            if (revision && scenario === "segment") continue
            const samples: Sample[] = []
            const measure = async (directory: string, sessionID: string) => {
              const cpu = process.cpuUsage()
              let rss = process.memoryUsage().rss
              const sampler = setInterval(() => {
                rss = Math.max(rss, process.memoryUsage().rss)
              }, 25)
              const started = performance.now()
              let success = false
              const metrics: Array<Parameters<typeof ObservabilityMetrics.record>[0]> = []
              try {
                if (scenario !== "segment") {
                  success = !!(await ObservabilityMetrics.withForwarder(
                    (metric) => metrics.push(metric),
                    () => track(sessionID, AbortSignal.timeout(30000)),
                  ))
                } else {
                  const session = await Session.create({})
                  const message = await Session.updateMessage({
                    id: Identifier.ascending("message"),
                    sessionID: session.id,
                    role: "user",
                    isRoot: true,
                    agent: "synergy",
                    model: { providerID: "test", modelID: "test" },
                    time: { created: Date.now() },
                  })
                  const input = { sessionID: session.id, rootID: message.id, segmentID: crypto.randomUUID() }
                  await SessionFileChanges.begin(input)
                  const result = await MessageV2.get({ sessionID: session.id, messageID: message.id })
                  success = result.parts.some(
                    (part) => part.type === "patch" && part.hash && part.checkpoint?.status !== "incomplete",
                  )
                }
              } finally {
                clearInterval(sampler)
              }
              const ms = performance.now() - started
              const used = process.cpuUsage(cpu)
              const repository = SnapshotStore.repository(ScopeContext.current.scope.id)
              const packs = await fs.readdir(path.join(repository, "objects/pack")).catch(() => [])
              const storage = await command(["du", "-sk", path.join(repository, "objects")])
              samples.push({
                ms: +ms.toFixed(2),
                parentCpuMs: (used.user + used.system) / 1000,
                parentRssMiB: +(rss / 1024 / 1024).toFixed(1),
                packCount: packs.filter((file) => file.endsWith(".pack")).length,
                objectKiB: Number.parseInt(storage),
                success,
              })
              console.log(
                JSON.stringify({
                  size,
                  scenario,
                  sample: samples.length,
                  ...samples.at(-1),
                  phases: Object.fromEntries(
                    metrics
                      .filter((metric) => metric.name.endsWith("duration"))
                      .map((metric) => [metric.name, +metric.value.toFixed(2)]),
                  ),
                }),
              )
            }
            const prepare = async (directory: string) => {
              for (let offset = 0; offset < data.length; offset += 32)
                await Promise.all(
                  data.slice(offset, offset + 32).map(async (file) => {
                    const filename = path.join(directory, file.name)
                    await fs.mkdir(path.dirname(filename), { recursive: true })
                    await fs.writeFile(filename, file.bytes)
                  }),
                )
            }
            if (scenario === "cold" || scenario === "segment") {
              for (let iteration = 0; iteration < iterations; iteration++) {
                await using fixture = await tmpdir({ git: true })
                await prepare(fixture.path)
                await ScopeContext.provide({
                  scope: await fixture.scope(),
                  fn: () => measure(fixture.path, `cold-${iteration}`),
                })
              }
            } else {
              await using fixture = await tmpdir({ git: true })
              await prepare(fixture.path)
              await ScopeContext.provide({
                scope: await fixture.scope(),
                fn: async () => {
                  expect(await track("warm")).toBeTruthy()
                  for (let iteration = 0; iteration < iterations; iteration++) {
                    const changed = scenario.startsWith("changed-")
                      ? scenario === "changed-all"
                        ? size
                        : Number(scenario.slice(8))
                      : 0
                    for (let offset = 0; offset < changed; offset += 32)
                      await Promise.all(
                        data
                          .slice(offset, Math.min(changed, offset + 32))
                          .map((file) =>
                            fs.writeFile(
                              path.join(fixture.path, file.name),
                              Buffer.concat([Buffer.from(`change ${iteration}\n`), file.bytes]),
                            ),
                          ),
                      )
                    await measure(fixture.path, scenario === "new-session" ? `session-${iteration}` : "warm")
                  }
                },
              })
            }
            const ordered = samples.map((sample) => sample.ms).sort((a, b) => a - b)
            console.log(
              JSON.stringify({
                summary: true,
                implementation: revision ? "baseline" : "streamed",
                size,
                scenario,
                runs: samples.length,
                failures: samples.filter((sample) => !sample.success).length,
                p50Ms: ordered[Math.floor((ordered.length - 1) * 0.5)],
                p95Ms: ordered[Math.ceil((ordered.length - 1) * 0.95)],
                peakParentRssMiB: Math.max(...samples.map((sample) => sample.parentRssMiB)),
                finalPackCount: samples.at(-1)?.packCount,
                finalObjectKiB: samples.at(-1)?.objectKiB,
              }),
            )
          }
        }
      })
    } finally {
      await runtime.close()
      await Promise.all(baselineFiles.map((file) => fs.rm(file, { force: true, recursive: true })))
    }
  },
  30 * 60_000,
)
