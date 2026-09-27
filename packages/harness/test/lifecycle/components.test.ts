import { expect, test } from "bun:test"
import { RuntimeComponents, type RuntimeComponent } from "../../src/lifecycle/components"
import { RuntimeContext } from "../../src/lifecycle/context"
import { runtimeHome } from "../support/runtime-home"

async function owner() {
  const home = await runtimeHome()
  const context = RuntimeContext.create(home.host)
  return {
    context,
    async [Symbol.asyncDispose]() {
      context.dispose()
      await home[Symbol.asyncDispose]()
    },
  }
}

function component(id: string, input: Partial<RuntimeComponent> = {}): RuntimeComponent {
  return { id, version: "1.0.0", apiVersion: 1, register() {}, ...input }
}

test("component composition orders required and optional predecessors without installing optional peers", () => {
  const core = component("core")
  const format = component("formatter", { requires: { core: "^1.0.0" } })
  const lsp = component("lsp", { requires: { core: "^1.0.0" }, after: ["formatter"] })
  expect(RuntimeComponents.resolve([lsp, core]).map((item) => item.id)).toEqual(["core", "lsp"])
  expect(RuntimeComponents.resolve([lsp, format, core]).map((item) => item.id)).toEqual(["core", "formatter", "lsp"])
})

test("invalid component graphs fail before any component registers", () => {
  let registrations = 0
  const core = component("core", { register: () => registrations++ })
  expect(() => RuntimeComponents.compose([core, component("core")])).toThrow("Duplicate component")
  expect(() => RuntimeComponents.compose([component("lsp", { requires: { core: "^1.0.0" } })])).toThrow("requires core")
  expect(() => RuntimeComponents.compose([core, component("lsp", { requires: { core: "^2.0.0" } })])).toThrow(
    "incompatible",
  )
  expect(() =>
    RuntimeComponents.compose([component("a", { requires: { b: "*" } }), component("b", { requires: { a: "*" } })]),
  ).toThrow("cycle")
  expect(registrations).toBe(0)
})

test("component lifecycle cleans a partially initialized owner and every predecessor in reverse order", async () => {
  await using runtime = await owner()
  await runtime.context.run(async () => {
    const events: string[] = []
    const composition = RuntimeComponents.compose([
      component("a", {
        services: () => ({
          initializeExtensions: async () => {
            events.push("a:start")
          },
          disposeExtensions: async () => {
            events.push("a:stop")
          },
        }),
      }),
      component("b", {
        requires: { a: "*" },
        services: () => ({
          initializeExtensions: async () => {
            events.push("b:start")
            throw new Error("start failed")
          },
          disposeExtensions: async () => {
            events.push("b:stop")
            throw new Error("cleanup failed")
          },
        }),
      }),
      component("c", {
        requires: { b: "*" },
        services: () => ({
          initializeExtensions: async () => {
            events.push("c:start")
          },
          disposeExtensions: async () => {
            events.push("c:stop")
          },
        }),
      }),
    ])
    composition.register()
    const services = composition.services!()
    await expect(services.initializeExtensions!()).rejects.toThrow("start failed")
    await expect(services.disposeExtensions!()).rejects.toThrow("cleanup failed")
    expect(events).toEqual(["a:start", "b:start", "b:stop", "a:stop"])
    await services.disposeExtensions!()
    expect(events).toHaveLength(4)
  })
})

test("component lifecycle refuses multiple HTTP transports before starting services", async () => {
  await using runtime = await owner()
  runtime.context.run(() => {
    const transport = { listen: () => ({ stop() {} }), closeAdmission() {} }
    const composition = RuntimeComponents.compose([
      component("a", { services: () => ({ transport }) }),
      component("b", { services: () => ({ transport }) }),
    ])
    composition.register()
    expect(() => composition.services!()).toThrow("Multiple transport")
  })
})

test("reusing a composition keeps registration and resources private to each runtime", async () => {
  await using first = await owner()
  await using second = await owner()
  const registered: string[] = []
  const active = new Set<string>()
  const composition = RuntimeComponents.compose([
    component("shared", {
      register() {
        registered.push(RuntimeContext.current().host.root)
      },
      services() {
        const root = RuntimeContext.current().host.root
        return {
          async initializeExtensions() {
            active.add(root)
          },
          async disposeExtensions() {
            active.delete(root)
          },
        }
      },
    }),
  ])
  const open = (context: RuntimeContext.Instance) =>
    context.run(async () => {
      composition.register()
      composition.register()
      await composition.services!().initializeExtensions!()
    })
  await Promise.all([open(first.context), open(second.context)])
  expect(registered).toEqual([first.context.host.root, second.context.host.root])
  expect(active.size).toBe(2)
  await first.context.run(() => composition.services!().disposeExtensions!())
  expect([...active]).toEqual([second.context.host.root])
  await second.context.run(() => composition.services!().disposeExtensions!())
  expect(active.size).toBe(0)
})
