import { RuntimeContext } from "../../src/lifecycle/context"
import { ObservabilityMetrics } from "../../src/observability/metrics"
import { ObservabilityStore } from "../../src/observability/store"
import { ObservabilityWriter } from "../../src/observability/writer"
import { Log } from "../../src/util/log"
import { runtimeHome } from "./runtime-home"

export async function storageTestRuntime() {
  const home = await runtimeHome()
  const context = RuntimeContext.create(home.host)
  return {
    run: context.run,
    async close() {
      try {
        await context.run(async () => {
          const errors: unknown[] = []
          for (const stop of [
            ObservabilityWriter.stop,
            ObservabilityMetrics.stop,
            ObservabilityStore.stop,
            Log.close,
          ]) {
            try {
              await stop()
            } catch (error) {
              errors.push(error)
            }
          }
          if (errors.length) throw new AggregateError(errors, "Storage test resources did not settle")
        })
      } finally {
        context.dispose()
        await home[Symbol.asyncDispose]()
      }
    },
  }
}
