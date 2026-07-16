import z from "zod"
import { BusEvent } from "../bus/bus-event"

export const NavigationUpdated = BusEvent.define(
  "clarus.navigation.updated",
  z.strictObject({
    timestamp: z.number().optional(),
  }),
)
