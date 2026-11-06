import path from "node:path"
import { RuntimeHandle } from "../../src/lifecycle/runtime"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { runtimeHome } from "./runtime-home"

export async function rolloutTestRuntime() {
  const home = await runtimeHome()
  try {
    const runtime = await RuntimeHandle.open({
      host: home.host,
      composition: { register() {} },
      mode: "oneshot",
      storage: {
        kind: "owned",
        async open() {
          const store = await TransactionalStore.open({
            backend: "sqlite",
            filename: path.join(home.host.root, "authority.sqlite"),
            namespace: "test",
          })
          return {
            handle: { store, artifactDirectory: path.join(home.host.root, "data") },
            needsValidation: false,
            async activate() {},
          }
        },
      },
    })
    const close = () => runtime.close().finally(() => home[Symbol.asyncDispose]())
    return { ...runtime, close }
  } catch (error) {
    await home[Symbol.asyncDispose]()
    throw error
  }
}
