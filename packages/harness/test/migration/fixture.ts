import { initializeSqliteEngine } from "../../src/storage/sqlite-engine"
import path from "node:path"
import { RuntimeContext } from "../../src/lifecycle/context"
import { ScopeRuntime } from "../../src/scope/runtime"
import { ObservabilityMetrics } from "../../src/observability/metrics"
import { ObservabilityStore } from "../../src/observability/store"
import { Log } from "../../src/util/log"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { runtimeHome } from "../support/runtime-home"

export async function migrationFixture(
  options: { home?: string; env?: Record<string, string | undefined>; register?: () => void } = {},
) {
  initializeSqliteEngine()
  const fixture = await runtimeHome({ home: options.home })
  const host = { ...fixture.host, env: { ...fixture.host.env, ...options.env } }
  const context = RuntimeContext.create(host)
  let store: TransactionalStore | undefined
  let closing: Promise<void> | undefined
  const close = () =>
    (closing ??= context.run(async () => {
      const errors: unknown[] = []
      for (const dispose of [
        () => ScopeRuntime.stop(),
        () => ObservabilityMetrics.stop(),
        () => ObservabilityStore.stop(),
        () => Log.close(),
        () => store?.close(),
      ]) {
        try {
          await dispose()
        } catch (error) {
          errors.push(error)
        }
      }
      context.dispose()
      await fixture[Symbol.asyncDispose]()
      if (errors.length) throw new AggregateError(errors, "Migration fixture cleanup failed")
    }))
  try {
    if (options.register) context.run(options.register)
    store = await TransactionalStore.open({
      backend: "sqlite",
      namespace: "migration-test",
      filename: path.join(host.root, "migration.sqlite"),
    })
    context.storage = { store, artifactDirectory: path.join(host.root, "data") }
    return { host, [Symbol.asyncDispose]: close, run: context.run, bind: context.bind, close }
  } catch (error) {
    try {
      await close()
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Migration fixture failed")
    }
    throw error
  }
}
