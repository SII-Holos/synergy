import { AgentTurn } from "../../src/session/agent-turn"
import { runInProcessStream } from "../../src/session/agent-turn/in-process"
import path from "node:path"
import { registerPolicyWorkerEntrypoint } from "../../src/enforcement/policy-worker/process-host"
import { RuntimeHandle, type RuntimeComposition } from "../../src/lifecycle/runtime"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { runtimeHome } from "./runtime-home"

export async function testRuntime(
  options: {
    home?: string
    register?: () => void
    composition?: RuntimeComposition
    env?: Record<string, string | undefined>
  } = {},
) {
  const fixture = await runtimeHome({ home: options.home })
  const host = { ...fixture.host, env: { ...fixture.host.env, ...options.env } }
  try {
    const runtime = await RuntimeHandle.open({
      host,
      composition: {
        ...options.composition,
        register() {
          AgentTurn.setInProcessStream(runInProcessStream)
          if (options.composition) options.composition.register()
          else registerPolicyWorkerEntrypoint(new URL("./policy-worker.ts", import.meta.url))
          options.register?.()
        },
      },
      mode: "oneshot",
      storage: {
        kind: "owned",
        async open() {
          const store = await TransactionalStore.open({
            backend: "sqlite",
            filename: path.join(host.root, "authority.sqlite"),
            namespace: "test",
          })
          return {
            handle: { store, artifactDirectory: path.join(host.root, "data") },
            needsValidation: false,
            async activate() {},
          }
        },
      },
    })
    let closing: Promise<void> | undefined
    const close = () => (closing ??= runtime.close().finally(() => fixture[Symbol.asyncDispose]()))
    return { ...runtime, host, close, [Symbol.asyncDispose]: close }
  } catch (error) {
    await fixture[Symbol.asyncDispose]()
    throw error
  }
}
