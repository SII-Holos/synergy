import { createHash } from "node:crypto"
import { z } from "zod"
import { OrganizationSyncProtocol as Sync } from "@ericsanchezok/synergy-organization-protocol"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import type { Migration } from "@ericsanchezok/synergy-harness/migration/types"
import { OrganizationStoragePath as Keys } from "./storage/path"
import { OrganizationRecord as Record } from "./storage/records"

const base = (sessionID: string, generation: number) => ["organization", "transcript", sessionID, String(generation)]
const Preparation = z.strictObject({
  schemaVersion: z.literal(3),
  cursor: z.string().optional(),
  complete: z.boolean(),
})

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
export const sharedWindowMigration: Migration = {
  id: "20261111-organization-transcript-windows",
  description: "Version chronological message and per-message part projection indexes",
  scope: "global",
  execution: "startup",
  async up(progress) {
    await Storage.write(["organization", "transcript-window-schema"], { schemaVersion: 2 })
    progress(1, 1)
  },
}
export const sharedWindowHistoryMigration: Migration = {
  id: "20261111-organization-transcript-window-history",
  description: "Retain as-of versions and tombstones for stable shared transcript windows",
  scope: "global",
  execution: "startup",
  async up(progress) {
    await Storage.write(["organization", "transcript-window-schema"], { schemaVersion: 3 })
    progress(1, 1)
  },
}

function objectIdentity(type: Sync.Event["type"], sourceSessionID: string | undefined, id: string) {
  return createHash("sha256")
    .update(JSON.stringify([type, sourceSessionID ?? null, id]))
    .digest("hex")
}

function identity(rootSessionID: string, event: Sync.Event) {
  const sessionID =
    event.type === "session" ? event.session.sessionID : event.sessionID === rootSessionID ? undefined : event.sessionID
  let id: string
  switch (event.type) {
    case "session":
      id = event.session.sessionID
      break
    case "message":
      id = event.messageID
      break
    case "part":
      id = event.partID
      break
    case "tool":
      id = event.callID
      break
    case "attachment":
      id = event.attachmentID
      break
    case "cortex":
      id = event.taskID
      break
    case "notification":
      id = event.notificationID
      break
    case "blob":
      id = event.blobID
      break
  }
  return objectIdentity(event.type, sessionID, id)
}

export namespace OrganizationSharedProjection {
  export const root = (sessionID: string, generation: number) => [...base(sessionID, generation), "current-v2"]
  export const messages = (sessionID: string, generation: number, sourceSessionID: string) => [
    ...base(sessionID, generation),
    "messages-v3",
    sourceSessionID,
  ]
  export const parts = (sessionID: string, generation: number, sourceSessionID: string, messageID: string) => [
    ...base(sessionID, generation),
    "parts-v3",
    sourceSessionID,
    messageID,
  ]
  const versions = (sessionID: string, generation: number, objectID: string) => [
    ...base(sessionID, generation),
    "versions-v3",
    objectID,
  ]
  export async function at(sessionID: string, generation: number, objectID: string, watermark: number) {
    const prefix = versions(sessionID, generation, objectID)
    const rows = await Storage.query({
      prefix,
      after: [...prefix, String(watermark).padStart(20, "0") + "~"],
      descending: true,
      limit: 1,
    })
    if (!rows.length) return
    const { sequence } = z.strictObject({ sequence: Sync.Sequence }).parse(rows[0]!.value)
    return Record.read(Record.SharedEvent, Keys.sharedEvent(sessionID, generation, sequence))
  }
  export function message(
    sessionID: string,
    generation: number,
    sourceSessionID: string,
    messageID: string,
    watermark?: number,
  ) {
    const objectID = objectIdentity("message", sourceSessionID === sessionID ? undefined : sourceSessionID, messageID)
    if (watermark !== undefined) return at(sessionID, generation, objectID, watermark)
    return Record.read(Record.SharedEvent, [...root(sessionID, generation), objectID])
  }
  export function matchesIndex(sessionID: string, generation: number, event: Sync.Event, key: string[]) {
    return JSON.stringify(indexKey(sessionID, generation, event)) === JSON.stringify(key)
  }

  function indexKey(sessionID: string, generation: number, event: Sync.Event) {
    if (event.type === "message")
      return [
        ...messages(sessionID, generation, event.sessionID ?? sessionID),
        String(event.createdAt).padStart(20, "0"),
        event.messageID,
      ]
    if (event.type === "part")
      return [...parts(sessionID, generation, event.sessionID ?? sessionID, event.messageID), event.partID]
  }

  export async function write(sessionID: string, generation: number, event: Sync.Event) {
    const objectID = identity(sessionID, event)
    if (event.type === "message" || event.type === "part") {
      await Storage.write([...versions(sessionID, generation, objectID), String(event.sequence).padStart(20, "0")], {
        sequence: event.sequence,
      })
      const index = indexKey(sessionID, generation, event)!
      await Storage.write(index, { objectID })
    }
    const key = [...root(sessionID, generation), objectID]
    const previous = await Record.read(Record.SharedEvent, key)
    if (previous && previous.event.sequence > event.sequence) return
    await Storage.write(key, Record.SharedEvent.parse({ schemaVersion: 1, event }))
  }

  export async function prepare(sessionID: string, generation: number, authorize: () => Promise<unknown>) {
    const key = [...base(sessionID, generation), "preparation-v3"]
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
        for (const row of rows)
          await write(sessionID, generation, Record.parse(Record.SharedEvent, row.key, row.value).event)
        await Storage.write(
          key,
          Preparation.parse({
            schemaVersion: 3,
            cursor: rows.at(-1)?.key.at(-1) ?? state?.cursor,
            complete: rows.length < 256,
          }),
        )
      })
    }
  }
}
