import { createHash } from "node:crypto"
import { z } from "zod"
import { OrganizationSyncProtocol as Sync } from "@ericsanchezok/synergy-organization-protocol"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import type { Migration } from "@ericsanchezok/synergy-harness/migration/types"
import { OrganizationStoragePath as Keys } from "./storage/path"
import { OrganizationRecord as Record } from "./storage/records"

const base = (sessionID: string, generation: number) => ["organization", "transcript", sessionID, String(generation)]
const Preparation = z.strictObject({ schemaVersion: z.literal(1), cursor: z.string().optional(), complete: z.boolean() })

export const sharedProjectionMigration: Migration = {
  id: "20261111-organization-transcript-projection",
  description: "Version shared transcript indexes with preparation owned by each sharing generation",
  scope: "global",
  execution: "startup",
  async up(progress) {
    await Storage.write(["organization", "transcript-schema"], { schemaVersion: 1 })
    progress(1, 1)
  },
}

function identity(event: Sync.Event) {
  const sessionID = event.type === "session" ? event.session.sessionID : event.sessionID
  let id: string
  switch (event.type) {
    case "session": id = event.session.sessionID; break
    case "message": id = event.messageID; break
    case "part": id = event.partID; break
    case "tool": id = event.callID; break
    case "attachment": id = event.attachmentID; break
    case "cortex": id = event.taskID; break
    case "notification": id = event.notificationID; break
    case "blob": id = event.blobID; break
  }
  return createHash("sha256").update(JSON.stringify([event.type, sessionID ?? null, id])).digest("hex")
}

export namespace OrganizationSharedProjection {
  export const root = (sessionID: string, generation: number) => [...base(sessionID, generation), "current"]

  export async function write(sessionID: string, generation: number, event: Sync.Event) {
    const key = [...root(sessionID, generation), identity(event)]
    const previous = await Record.read(Record.SharedEvent, key)
    if (previous && previous.event.sequence > event.sequence) return
    await Storage.write(key, Record.SharedEvent.parse({ schemaVersion: 1, event }))
  }

  export async function prepare(sessionID: string, generation: number, authorize: () => Promise<unknown>) {
    const key = [...base(sessionID, generation), "preparation"]
    for (;;) {
      const state = await Record.read(Preparation, key)
      if (state?.complete) return
      const prefix = Keys.sharedEvents(sessionID, generation)
      const rows = await Storage.snapshot(async () => {
        await authorize()
        return Storage.query({ prefix, after: state?.cursor ? [...prefix, state.cursor] : undefined, limit: 256 })
      })
      await Storage.transaction(async () => {
        await authorize()
        const current = await Record.read(Preparation, key)
        if (current?.complete || current?.cursor !== state?.cursor) return
        for (const row of rows) await write(sessionID, generation, Record.parse(Record.SharedEvent, row.key, row.value).event)
        await Storage.write(key, Preparation.parse({ schemaVersion: 1, cursor: rows.at(-1)?.key.at(-1) ?? state?.cursor, complete: rows.length < 256 }))
      })
    }
  }
}
