import z from "zod"
import { BusEvent } from "@/bus/bus-event"
import { SnapshotSchema } from "@/session/snapshot-schema"
import { Info, StatusInfo } from "./types"
import { SessionNavEntry } from "./nav"

export const SessionEvent = {
  Updated: BusEvent.define(
    "session.updated",
    z.object({
      info: Info,
      navEntry: SessionNavEntry.optional(),
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
      diff: SnapshotSchema.FileDiff.array(),
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
  Completion: BusEvent.define(
    "session.completion",
    z.object({
      sessionID: z.string(),
      unreadCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    }),
  ),
  Idle: BusEvent.define(
    "session.idle",
    z.object({
      sessionID: z.string(),
    }),
  ),
}
