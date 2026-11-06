import { parseArgs } from "node:util"
import { cpus } from "node:os"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { createHash } from "node:crypto"
import { SecretEvaluation } from "../src/evaluation"
import { SecretDetection } from "../src/detector"

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    help: { type: "boolean" },
    detector: { type: "string" },
    dataset: { type: "string" },
    samples: { type: "string", default: "100" },
    warmup: { type: "string", default: "20" },
    "timeout-ms": { type: "string", default: "5000" },
    output: { type: "string" },
  },
})

if (values.help) {
  console.log(
    "Usage: bun run evaluate [--detector module.ts] [--dataset corpus.json] [--samples 100] [--warmup 20] [--timeout-ms 5000] [--output report.json]\nThe optional module exports detector: SecretDetection.Detector. Inputs are synthetic by default. Reports contain metrics, never sample text or detected values.",
  )
} else {
  const samples = Number(values.samples)
  const warmup = Number(values.warmup)
  const timeoutMs = Number(values["timeout-ms"])
  if (
    !Number.isInteger(samples) ||
    samples < 1 ||
    !Number.isInteger(warmup) ||
    warmup < 0 ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  ) {
    throw new Error("Invalid samples, warmup or timeout-ms")
  }
  const loadStart = performance.now()
  const detector: SecretDetection.Detector = values.detector
    ? (await import(pathToFileURL(resolve(values.detector)).href)).detector
    : (await import("../src/regex")).RegexDetector
  const adapterImportMs = performance.now() - loadStart
  if (!detector?.id || !detector.version || typeof detector.detect !== "function")
    throw new Error("Adapter must export a versioned detector")
  const corpus = await Bun.file(
    values.dataset ? resolve(values.dataset) : new URL("../fixtures/corpus.json", import.meta.url),
  ).text()
  const dataset = SecretEvaluation.Dataset.parse(JSON.parse(corpus))
  const evaluation = await SecretEvaluation.evaluate(detector, dataset.cases, { timeoutMs })
  const timings = []
  const filler = "INFO compile completed successfully; const count = 123; request finished.\n"
  for (const bytes of [1024, 65536, 1048576]) {
    for (const injected of [0, 1, 32]) {
      const tail = Array.from({ length: injected }, (_, i) => ` ghp_benchmark${i.toString().padStart(8, "0")}`).join("")
      const text = filler.repeat(Math.ceil(bytes / filler.length)).slice(0, bytes - tail.length) + tail
      const rssBeforeBytes = process.memoryUsage().rss
      const cpuBefore = process.cpuUsage()
      try {
        const timing = await SecretEvaluation.benchmark(
          detector,
          { text, source: "tool_output" },
          { samples, warmup, timeoutMs },
        )
        const cpu = process.cpuUsage(cpuBefore)
        timings.push({
          bytes: Buffer.byteLength(text),
          injected,
          status: "complete",
          ...timing,
          cpuUserMicros: cpu.user,
          cpuSystemMicros: cpu.system,
          rssBeforeBytes,
          rssAfterBytes: process.memoryUsage().rss,
        })
      } catch (error) {
        timings.push({
          bytes: Buffer.byteLength(text),
          injected,
          status: "failed",
          error: error instanceof SecretDetection.Error ? error.code : "detector_failed",
        })
      }
    }
  }
  const hash = createHash("sha256")
  for (const name of ["detector", "regex", "patterns", "evaluation", "index"])
    hash.update(await Bun.file(new URL(`../src/${name}.ts`, import.meta.url)).text())
  hash.update(await Bun.file(new URL(import.meta.url)).text())
  const report = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    dataset: { version: dataset.version, sha256: createHash("sha256").update(corpus).digest("hex") },
    evaluatorSourceSha256: hash.digest("hex"),
    adapterModuleSha256: values.detector
      ? createHash("sha256")
          .update(await Bun.file(resolve(values.detector)).text())
          .digest("hex")
      : null,
    environment: {
      runtime: `Bun ${Bun.version}`,
      platform: process.platform,
      arch: process.arch,
      cpu: cpus()[0]?.model,
    },
    settings: { samples, warmup, timeoutMs },
    adapterImportMs,
    scope:
      "Detector plus async contract validation only; no Vault, disk or session latency; includes inference/transport if the selected adapter uses it. Accuracy evaluation precedes timing; firstCallMs is per scenario, not model cold start; RSS is sampled, not peak memory. Adapter version must identify model weights and configuration when applicable.",
    evaluation,
    timings,
  }
  const output = JSON.stringify(report, null, 2) + "\n"
  if (values.output) await Bun.write(resolve(values.output), output)
  else console.log(output)
  if (evaluation.metrics.failures || evaluation.metrics.incomplete || timings.some((item) => item.status === "failed"))
    process.exitCode = 1
}
