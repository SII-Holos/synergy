import { RuntimeContext } from "../src/lifecycle/context"
import { parseArgs } from "node:util"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir, cpus } from "node:os"
import { join } from "node:path"

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    samples: { type: "string", default: "20" },
    quick: { type: "boolean" },
    help: { type: "boolean" },
  },
})
if (values.help) {
  console.log(
    "Usage: bun run benchmark:secrets [--samples 20] [--quick]\nMeasures captureAndApply with synthetic values in an automatically removed isolated home. No server or model is started.",
  )
  process.exit(0)
}
const samples = Number(values.samples)
if (!Number.isInteger(samples) || samples < 1) throw new Error("samples must be a positive integer")
const home = await mkdtemp(join(tmpdir(), "synergy-secret-bench-"))
process.env.SYNERGY_HOME = home
process.env.SYNERGY_TEST_HOME = home
process.env.SYNERGY_TEST_ROOT = home
process.env.SYNERGY_DISABLE_MODELS_FETCH = "true"

try {
  await RuntimeContext.create({ home, root: join(home, ".synergy"), env: process.env }).run(async () => {
    const { Global } = await import("../src/global")
    await Global.initialize()
    const { SecretVault } = await import("../src/secrets/vault")
    const { SecretMask } = await import("../src/secrets/mask")
    const summarize = (measurements: number[]) => {
      const sorted = [...measurements].sort((a, b) => a - b)
      return { p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1], p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] }
    }
    const rows = []
    for (const vaultSize of values.quick ? [0] : [0, 100, 1000]) {
      await rm(Global.Path.secretVault, { force: true })
      await SecretVault.registerMany(
        Array.from({ length: vaultSize }, (_, i) => `benchmark-vault-value-${i.toString().padStart(8, "0")}`),
        { kind: "user" },
      )
      const emptySnapshot = vaultSize
        ? await Bun.file(Global.Path.secretVault).text()
        : JSON.stringify({ schemaVersion: 1, entries: {} })
      for (const bytes of values.quick ? [1024] : [1024, 65536]) {
        for (const hits of values.quick ? [1] : [0, 1, 16]) {
          const candidates = Array.from({ length: hits }, (_, i) => `ghp_benchmark${i.toString().padStart(8, "0")}`)
          const tail = " " + candidates.join(" ")
          const text = "ordinary log text; ".repeat(Math.ceil(bytes / 19)).slice(0, bytes - tail.length) + tail
          for (const mode of ["first-registration", "already-registered"] as const) {
            await Bun.write(Global.Path.secretVault, emptySnapshot, { mode: 0o600 })
            if (mode === "already-registered")
              await SecretVault.registerMany(candidates, { kind: "heuristic", context: "tool_output" })
            const snapshot = await Bun.file(Global.Path.secretVault).text()
            const measurements: number[] = []
            const cpuBefore = process.cpuUsage()
            for (let i = 0; i < samples + 2; i++) {
              await Bun.write(Global.Path.secretVault, snapshot, { mode: 0o600 })
              const start = performance.now()
              const masked = await SecretMask.captureAndApply(text, { kind: "heuristic", context: "tool_output" })
              const elapsed = performance.now() - start
              if (candidates.some((value) => masked.includes(value))) throw new Error("Benchmark masking failed")
              if (i >= 2) measurements.push(elapsed)
            }
            rows.push({
              vaultSize,
              bytes: Buffer.byteLength(text),
              hits,
              mode,
              samples,
              ...summarize(measurements),
              cpuIncludingFixtureReset: process.cpuUsage(cpuBefore),
              rssAfterBytes: process.memoryUsage().rss,
            })
          }
        }
      }
    }
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          environment: { runtime: Bun.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model },
          scope:
            "Actual captureAndApply: detector, validation, deduplication, Vault and replacement. Synthetic data, warm filesystem; fixture reset and two warmups excluded from latency. CPU includes fixture resets; RSS is not peak. No session or model inference.",
          rows,
        },
        null,
        2,
      ),
    )
  })
} finally {
  await rm(home, { recursive: true, force: true })
}
