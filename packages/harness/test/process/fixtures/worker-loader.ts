import path from "node:path"
import { RuntimeContext } from "../../../src/lifecycle/context"
import { SqliteWorkerClient } from "../../../src/storage/sqlite-worker-client"
import { ObservabilityTelemetryClient } from "../../../src/observability/telemetry-client"

const [root, role, marker] = process.argv.slice(2)
const owner = RuntimeContext.create({
  home: root!,
  root: root!,
  env: {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    SYNERGY_TEST_HOME: root,
    SYNERGY_FIXTURE_PRELOAD_MARKER: marker,
  },
})
try {
  await owner.run(async () => {
    if (role === "storage") {
      const client = new SqliteWorkerClient("writer")
      try {
        await client.request({ action: "open", filename: path.join(root!, "storage.sqlite") })
        const result = await client.request({ action: "query", statement: "SELECT 1 AS value" })
        if (result.rows[0]?.value !== 1n) throw new Error("Storage worker did not execute its request")
      } finally {
        await client.close()
      }
    } else {
      ObservabilityTelemetryClient.start({
        dbPath: path.join(root!, "telemetry.sqlite"),
        config: {
          maxSqliteBytes: 16 * 1024 * 1024,
          walCheckpointIntervalMs: 60_000,
          metricRetentionMs: 86_400_000,
          traceRetentionMs: 86_400_000,
          maintenanceBudgetMs: 500,
        },
      })
      try {
        const until = Date.now() + 10_000
        while (!ObservabilityTelemetryClient.stats().workerReady && Date.now() < until) await Bun.sleep(10)
        if (!ObservabilityTelemetryClient.stats().workerReady) throw new Error("Telemetry worker did not become ready")
        await ObservabilityTelemetryClient.flushAndWait()
      } finally {
        await ObservabilityTelemetryClient.stop()
      }
    }
    console.log(JSON.stringify({ completed: true, preload: await Bun.file(marker!).exists() }))
  })
} finally {
  owner.dispose()
}
