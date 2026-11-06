import { z } from "zod"
import type { ZodType } from "zod"
import { RuntimeContext } from "../lifecycle/context"

export namespace BusEvent {
  export type Definition = ReturnType<typeof define>

  const registry = RuntimeContext.state(() => new Map<string, Definition>())

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
    return result
  }

  export function register(...definitions: Definition[]) {
    RuntimeContext.assertCompositionOpen("event schemas")
    for (const definition of definitions) {
      const existing = registry().get(definition.type)
      if (existing && existing !== definition) throw new Error(`Duplicate event schema: ${definition.type}`)
      registry().set(definition.type, definition)
    }
  }

  export function payloads() {
    const variants = [...registry().values()].map((definition) =>
      z
        .object({ type: z.literal(definition.type), properties: definition.properties })
        .meta({ ref: `Event.${definition.type}` }),
    )
    const [first, ...rest] = variants
    return (first ? z.discriminatedUnion("type", [first, ...rest]) : z.never()).meta({ ref: "Event" })
  }
}
