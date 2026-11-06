import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import { ObservabilityConfig } from "../../src/observability/config"
import { ObservabilityIssues } from "../../src/observability/issues"
import { ObservabilityStore } from "../../src/observability/store"
import { ObservabilityWriter } from "../../src/observability/writer"
import { clearObservabilityState, resetObservabilityState } from "./fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

describe("ObservabilityWriter", () => {
  beforeEach(() =>
    runtime.run(() => {
      resetObservabilityState()
      ObservabilityConfig.refresh({ observability: { performance: { storage: { jsonlMirrorEnabled: true } } } })
    }),
  )
  afterEach(() => runtime.run(() => clearObservabilityState()))

  test("flushes mirror entries and records backpressure as indexed telemetry", () =>
    runtime.run(async () => {
      const file = path.join(process.env.SYNERGY_TEST_HOME!, "state", "observability", "traces", "test.jsonl")
      ObservabilityWriter.append(file, '{"type":"one"}\n')
      await ObservabilityWriter.flush()

      expect(await Bun.file(file).text()).toContain("one")

      for (let i = 0; i < 5_050; i++) ObservabilityWriter.append(file, `{"type":"${i}"}\n`)
      await ObservabilityWriter.flush()
      ObservabilityStore.flush()

      expect(
        ObservabilityStore.queryMetrics({ since: 0, names: ["observability.writer.dropped"] }).some(
          (row) => JSON.parse(row.labels_json).reason === "queue_full",
        ),
      ).toBe(true)
      expect(
        ObservabilityIssues.list({ module: "observability" }).some(
          (issue) => issue.code === "PERF_OBSERVABILITY_WRITER_BACKPRESSURE",
        ),
      ).toBe(true)
    }))
})

afterRuntimeTests(() => runtime.close())
