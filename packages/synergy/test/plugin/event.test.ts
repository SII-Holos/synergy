import { describe, expect, test } from "bun:test"
import z from "zod"
import { compilePluginManifest, definePlugin, event } from "@ericsanchezok/synergy-plugin"
import { Bus } from "../../src/bus"
import { ScopeContext } from "../../src/scope/context"
import { PluginEvent } from "../../src/plugin/event"
import { executePluginHostService } from "../../src/plugin/host-services-runtime"
import { tmpdir } from "../fixture/fixture"

describe("plugin events", () => {
  test("validates declarations and stamps plugin, generation, Scope and sequence", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const manifest = compilePluginManifest(
      definePlugin({
        id: "event-test",
        version: "1.0.0",
        description: "Event contract test",
        contributions: [event({ id: "changed", payload: z.object({ value: z.number() }) })],
      }),
      { generation: "event-generation" },
    )

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const received: any[] = []
        const unsubscribe = Bus.subscribe(PluginEvent.Published, (value) => received.push(value.properties))
        const invoke = (payload: unknown) =>
          executePluginHostService({
            pluginId: manifest.id,
            pluginDir: tmp.path,
            manifest,
            invocation: { scopeId: scope.id, sessionId: "session-one", directory: tmp.path, actor: { type: "ui" } },
            method: "event.publish",
            params: { eventId: "changed", payload },
            signal: new AbortController().signal,
          })
        try {
          await invoke({ value: 1 })
          await invoke({ value: 2 })
          expect(received.map((item) => item.sequence)).toEqual([1, 2])
          expect(received[0]).toMatchObject({
            pluginId: "event-test",
            pluginVersion: "1.0.0",
            generation: "event-generation",
            eventId: "changed",
            scopeId: scope.id,
            sessionId: "session-one",
          })
          await expect(invoke({ value: "invalid" })).rejects.toThrow("payload is invalid")
        } finally {
          unsubscribe()
        }
      },
    })
  })
})
