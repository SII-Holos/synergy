import { z } from "zod"
import { BusEvent } from "@ericsanchezok/synergy-harness/bus/bus-event"
import { WorkspaceEvents } from "@ericsanchezok/synergy-harness/workspace/events"
import { WorkspaceFile } from "../workspace-file/types"

export const FileWatcherEvent = {
  Updated: BusEvent.define(
    "file.watcher.updated",
    z.object({
      ...WorkspaceEvents.Fields,
      file: z.string(),
      event: z.enum(["added", "changed", "deleted", "renamed"]),
      absolute: z.string().optional(),
      oldPath: z.string().optional(),
      oldAbsolute: z.string().optional(),
      parent: z.string().optional(),
      node: WorkspaceFile.Node.optional(),
      resync: z.boolean().optional(),
    }),
  ),
}
