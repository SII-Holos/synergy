import type { PluginUIEvents, PluginUILifetime } from "@ericsanchezok/synergy-plugin"
import type { Event } from "@ericsanchezok/synergy-sdk/client"

export function createPluginSurfaceEvents(input: {
  events: { listen(listener: (event: { name: string; details: Event }) => void): () => void }
  pluginId: string
  scopeId: string
  sessionId?: string
  generation: string
  eventIds: string[]
  lifetime: PluginUILifetime
}): PluginUIEvents {
  const declared = new Set(input.eventIds)
  return {
    subscribe(eventId, listener) {
      input.lifetime.signal.throwIfAborted()
      if (!declared.has(eventId)) throw new Error(`Plugin event ${eventId} is not declared`)
      return input.lifetime.onDispose(
        input.events.listen(({ details: event }) => {
          if (event.type !== "plugin.event") return
          const value = event.properties
          if (
            value.pluginId !== input.pluginId ||
            value.scopeId !== input.scopeId ||
            value.generation !== input.generation ||
            value.eventId !== eventId
          )
            return
          if (input.sessionId && value.sessionId && value.sessionId !== input.sessionId) return
          listener(value.payload, {
            generation: value.generation,
            scopeId: value.scopeId,
            sessionId: value.sessionId,
            sequence: value.sequence,
            timestamp: value.timestamp,
          })
        }),
      )
    },
  }
}
