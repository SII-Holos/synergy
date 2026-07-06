import { afterEach, describe, expect, mock, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import z from "zod"
import { Bus } from "../../src/bus"
import { BusEvent } from "../../src/bus/bus-event"
import { Config } from "../../src/config/config"
import { Plugin } from "../../src/plugin"
import { RuntimeReload } from "../../src/runtime/reload"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"

const originalGlobal = Config.global

const TestEvent = BusEvent.define("plugin.test.event", z.object({ value: z.string() }))
const SessionEvent = BusEvent.define("session.test.event", z.object({ value: z.string() }))
const OtherEvent = BusEvent.define("other.test.event", z.object({ value: z.string() }))

afterEach(() => {
  ;(Config as any).global = originalGlobal
})

async function writeEventPlugin(
  root: string,
  input: {
    id: string
    events?: "none" | "selected" | "all"
    eventNames?: string[]
    hookBody?: string
  },
) {
  const dir = path.join(root, input.id)
  await fs.mkdir(path.join(dir, "src"), { recursive: true })
  await Bun.write(
    path.join(dir, "plugin.json"),
    JSON.stringify(
      {
        name: input.id,
        version: "0.1.0",
        main: "./src/index.ts",
        description: "Event hook test plugin",
        runtime: { mode: "in-process" },
        permissions: { hooks: { events: input.events, eventNames: input.eventNames } },
      },
      null,
      2,
    ),
  )
  await Bun.write(
    path.join(dir, "src", "index.ts"),
    `export default {
  id: ${JSON.stringify(input.id)},
  async init() {
    return {
      event: async (input) => {
        ${input.hookBody ?? "globalThis.__synergyEventCalls.push(input.event.type)"}
      }
    }
  }
}
`,
  )
  return dir
}

async function providePlugins(root: string, dirs: string[], fn: () => Promise<void>) {
  ;(Config as any).global = mock(async () => ({
    plugin: dirs.map((dir) => pathToFileURL(dir).href),
    pluginMarketplace: { enabled: false },
    pluginRuntimePolicy: { allowLocalInProcess: true, highRiskRequiresProcess: false },
  }))

  await ScopeContext.provide({
    scope: await (await tmpdir({ git: true, init: async () => root })).scope(),
    fn,
  })
}

describe("plugin event hooks", () => {
  test("default selected mode with empty eventNames receives nothing", async () => {
    await using tmp = await tmpdir({ git: true })
    ;(globalThis as any).__synergyEventCalls = []
    const dir = await writeEventPlugin(tmp.path, { id: "default-event-plugin" })
    ;(Config as any).global = mock(async () => ({
      plugin: [pathToFileURL(dir).href],
      pluginMarketplace: { enabled: false },
      pluginRuntimePolicy: { allowLocalInProcess: true, highRiskRequiresProcess: false },
    }))

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await Plugin.init()
        await Bus.publish(TestEvent, { value: "a" })
        expect((globalThis as any).__synergyEventCalls).toEqual([])
      },
    })
  })

  test("selected event names support exact, prefix wildcard, and all modes", async () => {
    await using tmp = await tmpdir({ git: true })
    ;(globalThis as any).__synergyEventCalls = []
    const exact = await writeEventPlugin(tmp.path, {
      id: "exact-event-plugin",
      events: "selected",
      eventNames: ["plugin.test.event"],
      hookBody: `globalThis.__synergyEventCalls.push(["exact", input.event.type])`,
    })
    const prefix = await writeEventPlugin(tmp.path, {
      id: "prefix-event-plugin",
      events: "selected",
      eventNames: ["session.*"],
      hookBody: `globalThis.__synergyEventCalls.push(["prefix", input.event.type])`,
    })
    const all = await writeEventPlugin(tmp.path, {
      id: "all-event-plugin",
      events: "all",
      hookBody: `globalThis.__synergyEventCalls.push(["all", input.event.type])`,
    })
    ;(Config as any).global = mock(async () => ({
      plugin: [pathToFileURL(exact).href, pathToFileURL(prefix).href, pathToFileURL(all).href],
      pluginMarketplace: { enabled: false },
      pluginRuntimePolicy: { allowLocalInProcess: true, highRiskRequiresProcess: false },
    }))

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await Plugin.init()
        await Bus.publish(TestEvent, { value: "a" })
        await Bus.publish(SessionEvent, { value: "b" })
        await Bus.publish(OtherEvent, { value: "c" })
        expect((globalThis as any).__synergyEventCalls).toEqual([
          ["exact", "plugin.test.event"],
          ["all", "plugin.test.event"],
          ["prefix", "session.test.event"],
          ["all", "session.test.event"],
          ["all", "other.test.event"],
        ])
      },
    })
  })

  test("plugin reload does not duplicate event subscriptions", async () => {
    await using tmp = await tmpdir({ git: true })
    ;(globalThis as any).__synergyEventCalls = []
    const dir = await writeEventPlugin(tmp.path, {
      id: "reload-event-plugin",
      events: "all",
    })
    ;(Config as any).global = mock(async () => ({
      plugin: [pathToFileURL(dir).href],
      pluginMarketplace: { enabled: false },
      pluginRuntimePolicy: { allowLocalInProcess: true, highRiskRequiresProcess: false },
    }))

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await Plugin.init()
        await RuntimeReload.reload({ targets: ["plugin"], reason: "event-reload-test" })
        await Bus.publish(TestEvent, { value: "a" })
        expect((globalThis as any).__synergyEventCalls).toEqual(["plugin.test.event"])
      },
    })
  })

  test("throwing event hook disables only that plugin", async () => {
    await using tmp = await tmpdir({ git: true })
    ;(globalThis as any).__synergyEventCalls = []
    const bad = await writeEventPlugin(tmp.path, {
      id: "bad-event-plugin",
      events: "all",
      hookBody: `globalThis.__synergyEventCalls.push("bad"); throw new Error("event failed")`,
    })
    const good = await writeEventPlugin(tmp.path, {
      id: "good-event-plugin",
      events: "all",
      hookBody: `globalThis.__synergyEventCalls.push("good")`,
    })
    ;(Config as any).global = mock(async () => ({
      plugin: [pathToFileURL(bad).href, pathToFileURL(good).href],
      pluginMarketplace: { enabled: false },
      pluginRuntimePolicy: { allowLocalInProcess: true, highRiskRequiresProcess: false },
    }))

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await Plugin.init()
        await Bus.publish(TestEvent, { value: "a" })
        await Bus.publish(TestEvent, { value: "b" })
        expect((globalThis as any).__synergyEventCalls).toEqual(["bad", "good", "good"])
        expect((await Plugin.getDisabledPlugin("bad-event-plugin"))?.phase).toBe("hook")
      },
    })
  })
})
