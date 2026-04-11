import z from "zod"
import { BusEvent } from "@/bus/bus-event"
import { Snapshot } from "@/session/snapshot"
import { Info, StatusInfo } from "./types"

export const SessionEvent = {
  Created: BusEvent.define(
    "session.created",
    z.object({
      info: Info,
    }),
  ),
  Updated: BusEvent.define(
    "session.updated",
    z.object({
      info: Info,
    }),
  ),
  Deleted: BusEvent.define(
    "session.deleted",
    z.object({
      info: Info,
    }),
  ),
  Diff: BusEvent.define(
    "session.diff",
    z.object({
      sessionID: z.string(),
      diff: Snapshot.FileDiff.array(),
    }),
  ),
  Error: BusEvent.define(
    "session.error",
    z.object({
      sessionID: z.string().optional(),
      error: z.unknown().optional(),
    }),
  ),
  Status: BusEvent.define(
    "session.status",
    z.object({
      sessionID: z.string(),
      status: StatusInfo,
    }),
  ),
  Idle: BusEvent.define(
    "session.idle",
    z.object({
      sessionID: z.string(),
    }),
  ),
}
