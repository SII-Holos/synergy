import z from "zod"
import type { ZodType } from "zod"
import { Log } from "../util/log"

export namespace BusEvent {
  const log = Log.create({ service: "event" })

  export type Definition = ReturnType<typeof define>

  const registry = new Map<string, Definition>()

  export function define<Type extends string, Properties extends ZodType>(
    type: Type,
    properties: Properties,
    // High-frequency, coalescible events (e.g. part deltas) are marked
    // streaming: they are not sequenced or journaled, and the client applies
    // them without gap detection (a full snapshot/anchor always follows).
    options?: { streaming?: boolean },
  ) {
    const result = {
      type,
      properties,
      streaming: options?.streaming ?? false,
    }
    registry.set(type, result)
    return result
  }

  export function payloads() {
    return z
      .discriminatedUnion(
        "type",
        registry
          .entries()
          .map(([type, def]) => {
            return z
              .object({
                type: z.literal(type),
                properties: def.properties,
                seq: z.number().int().positive().optional(),
                epoch: z.string().optional(),
                streaming: z.boolean().optional(),
              })
              .meta({
                ref: "Event" + "." + def.type,
              })
          })
          .toArray() as any,
      )
      .meta({
        ref: "Event",
      })
  }
}
