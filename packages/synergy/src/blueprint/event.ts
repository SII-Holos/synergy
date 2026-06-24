import z from "zod"
import { BusEvent } from "../bus/bus-event"
import { Info } from "./types"

export namespace LoopEvent {
  export const Created = BusEvent.define(
    "blueprint_loop.created",
    z.object({
      loop: Info,
    }),
  )

  export const Updated = BusEvent.define(
    "blueprint_loop.updated",
    z.object({
      loop: Info,
    }),
  )

  export const Completed = BusEvent.define(
    "blueprint_loop.completed",
    z.object({
      loopID: z.string(),
    }),
  )

  export const Failed = BusEvent.define(
    "blueprint_loop.failed",
    z.object({
      loopID: z.string(),
      error: z.string(),
    }),
  )

  export const Cancelled = BusEvent.define(
    "blueprint_loop.cancelled",
    z.object({
      loopID: z.string(),
    }),
  )

  export const Auditing = BusEvent.define(
    "blueprint_loop.auditing",
    z.object({
      loopID: z.string(),
    }),
  )

  export const Restarted = BusEvent.define(
    "blueprint_loop.restarted",
    z.object({
      loopID: z.string(),
      reason: z.string(),
    }),
  )
}
