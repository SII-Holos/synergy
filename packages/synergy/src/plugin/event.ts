import z from "zod"
import { BusEvent } from "../bus/bus-event"

export namespace PluginEvent {
  export const Published = BusEvent.define(
    "plugin.event",
    z.object({
      pluginId: z.string(),
      pluginVersion: z.string(),
      generation: z.string(),
      eventId: z.string(),
      scopeId: z.string(),
      sessionId: z.string().optional(),
      sequence: z.number().int().positive(),
      timestamp: z.number().int().positive(),
      payload: z.unknown(),
    }),
  )
}
