import { expect, test } from "bun:test"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import type { Event } from "@ericsanchezok/synergy-sdk/client"
import { createPluginSurfaceEvents } from "../../src/plugin/surface-events"
import { createPluginSurfaceLifetime } from "../../src/plugin/surface-lifetime"

test("unwraps the real global event envelope and filters binding identity", () => {
  const emitter = createGlobalEmitter<{ [key: string]: Event }>()
  const lifetime = createPluginSurfaceLifetime(() => {})
  const events = createPluginSurfaceEvents({
    events: emitter,
    pluginId: "demo",
    scopeId: "scope-a",
    sessionId: "session-a",
    generation: "current",
    eventIds: ["changed"],
    lifetime: lifetime.context,
  })
  const values: unknown[] = []
  events.subscribe("changed", (value) => values.push(value))
  function emit(overrides: Partial<Extract<Event, { type: "plugin.event" }>["properties"]> = {}) {
    emitter.emit("directory", {
      type: "plugin.event",
      properties: {
        pluginId: "demo",
        pluginVersion: "1.0.0",
        generation: "current",
        eventId: "changed",
        scopeId: "scope-a",
        sessionId: "session-a",
        sequence: 1,
        timestamp: 1,
        payload: { changed: true },
        ...overrides,
      },
    })
  }
  emit()
  emit({ generation: "previous" })
  emit({ scopeId: "scope-b" })
  emit({ sessionId: "session-b" })
  emit({ pluginId: "other" })
  expect(values).toEqual([{ changed: true }])
  lifetime.dispose()
  emit()
  expect(values).toHaveLength(1)
  expect(() => events.subscribe("undeclared", () => {})).toThrow()
})
