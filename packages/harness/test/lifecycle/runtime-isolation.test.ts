import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { RuntimeHandle, type RuntimeComposition } from "../../src/lifecycle/runtime"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { Session } from "../../src/session"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Config } from "../../src/config/config"
import { Global } from "../../src/global"
import { GlobalBus } from "../../src/bus/global"
import { Identifier } from "../../src/id/id"

async function fixture(model: string, composition: RuntimeComposition = { register() {} }) {
  const home = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "runtime-"))
  const root = path.join(home, ".synergy")
  const cache = path.join(root, "cache")
  await fs.mkdir(cache, { recursive: true })
  await Bun.write(path.join(cache, "version"), "15")
  await Bun.write(path.join(cache, "models.json"), Bun.file(process.env.MODELS_DEV_API_JSON!))
  await fs.mkdir(path.join(root, "config", "synergy.d"), { recursive: true })
  await Bun.write(path.join(root, "config", "synergy.d", "10-models.jsonc"), JSON.stringify({ model }))
  const runtime = await RuntimeHandle.open({
    host: { home, root, env: { ...process.env, SYNERGY_TEST_HOME: home } },
    composition,
    mode: "oneshot",
    storage: {
      kind: "owned",
      async open() {
        const store = await TransactionalStore.open({
          backend: "sqlite",
          filename: path.join(root, "authority.sqlite"),
          namespace: "same",
        })
        return {
          handle: { store, artifactDirectory: path.join(root, "data") },
          needsValidation: false,
          async activate() {},
        }
      },
    },
  })
  return {
    runtime,
    home,
    async [Symbol.asyncDispose]() {
      await runtime.close()
      await fs.rm(home, { recursive: true, force: true })
    },
  }
}

test("two runtimes keep identical session identities, configuration and events separate after one closes", async () => {
  await using a = await fixture("openai/model-a")
  await using b = await fixture("openai/model-b")
  const id = Identifier.ascending("session")
  const eventsA: unknown[] = []
  const eventsB: unknown[] = []
  a.runtime.run(() => GlobalBus().on("event", (event) => eventsA.push(event)))
  b.runtime.run(() => GlobalBus().on("event", (event) => eventsB.push(event)))
  const scoped = <T>(runtime: RuntimeHandle.Handle, fn: () => T) =>
    runtime.run(() => ScopeContext.provide({ scope: Scope.home(), fn }))
  await scoped(a.runtime, () => Session.create({ id, title: "A" }))
  const aEvents = eventsA.length
  await scoped(b.runtime, () => Session.create({ id, title: "B" }))
  expect(eventsA.length).toBe(aEvents)
  expect(eventsB.length).toBeGreaterThan(0)
  expect((await scoped(a.runtime, () => Session.get(id))).title).toBe("A")
  expect((await scoped(b.runtime, () => Session.get(id))).title).toBe("B")
  expect((await scoped(a.runtime, () => Config.current())).model).toBe("openai/model-a")
  expect((await scoped(b.runtime, () => Config.current())).model).toBe("openai/model-b")
  expect(a.runtime.run(() => Global.Path.home)).toBe(a.home)
  expect(b.runtime.run(() => Global.Path.home)).toBe(b.home)
  await Promise.all([a.runtime.close(), a.runtime.close()])
  expect(a.runtime.status).toBe("closed")
  expect(() => a.runtime.run(() => Scope.home())).toThrow("closed")
  expect((await scoped(b.runtime, () => Session.get(id))).title).toBe("B")
  const next = await scoped(b.runtime, () => Session.create({ title: "B continues" }))
  expect((await scoped(b.runtime, () => Session.get(next.id))).title).toBe("B continues")
}, 30_000)
