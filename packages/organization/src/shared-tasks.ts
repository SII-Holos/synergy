import { z } from "zod"
import { OrganizationSyncProtocol as Sync } from "@ericsanchezok/synergy-organization-protocol"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import type { Migration } from "@ericsanchezok/synergy-harness/migration/types"
import { OrganizationRecord as Record } from "./storage/records"
import { OrganizationStoragePath as Keys } from "./storage/path"
import { fail } from "./error"

const Header = z.strictObject({
  version: z.literal(1),
  sessionID: z.string(),
  generation: z.number().int().nonnegative(),
  sequence: z.number().int().nonnegative().safe(),
})
const Sequence = z.strictObject({ sequence: Sync.Sequence })
const Child = z.strictObject({ sessionID: z.string().min(1) })
const root = (sessionID: string, generation: number) => [
  "organization",
  "task-projection",
  sessionID,
  String(generation),
]
const head = (sessionID: string, generation: number) => [...root(sessionID, generation), "checkpoint"]
const version = (sessionID: string, generation: number, kind: "session" | "cortex", child: string) => [
  ...root(sessionID, generation),
  "versions",
  kind,
  child,
]
const ordinal = (value: number) => String(value).padStart(16, "0")

export const sharedTaskMigration: Migration = {
  id: "20261112-organization-shared-task-pages",
  description: "Register watermark-owned task metadata indexes over canonical shared events",
  scope: "global",
  execution: "startup",
  async up(progress) {
    await Storage.write(["organization", "task-projection-schema"], { schemaVersion: 1 })
    progress(1, 1)
  },
}

export namespace OrganizationSharedTasks {
  export const generationPrefix = root
  export function history(
    source: Record.HistoricalReader & { accept(key: string[]): void },
    input: { sessionID: string; generation: number; watermark: number },
  ) {
    const { sessionID, generation, watermark } = input
    const prefix = root(sessionID, generation)
    let present = false
    for (const _row of source.entries(prefix)) {
      present = true
      break
    }
    if (!present) return
    const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
    function invalid(): never {
      return fail("PROTOCOL_MISMATCH", "Historical task metadata differs from its canonical events")
    }
    const checkpoint = source.read(Header, head(sessionID, generation))
    if (checkpoint.sessionID !== sessionID || checkpoint.generation !== generation || checkpoint.sequence > watermark)
      invalid()
    for (const row of source.entries(Keys.sharedEvents(sessionID, generation))) {
      const event = Record.SharedEvent.parse(row.value).event
      if (event.sequence > checkpoint.sequence) break
      if (event.type !== "session" && event.type !== "cortex") continue
      const child = event.type === "session" ? event.session.sessionID : event.sessionID
      const key = [...version(sessionID, generation, event.type, child), ordinal(event.sequence)]
      if (source.read(Sequence, key).sequence !== event.sequence) invalid()
      source.accept(key)
      if (event.type === "cortex") {
        const key = [...parents(sessionID, generation, event.parentSessionID), child]
        if (source.read(Child, key).sessionID !== child) invalid()
        source.accept(key)
      }
    }
    for (const row of source.entries(prefix)) {
      if (equal(row.key, head(sessionID, generation))) {
        if (!equal(row.value, checkpoint)) invalid()
        source.accept(row.key)
        continue
      }
      if (row.key[4] === "versions" && row.key.length === 8) {
        const { sequence } = Sequence.parse(row.value)
        if (sequence > checkpoint.sequence) invalid()
        const event = source.read(Record.SharedEvent, Keys.sharedEvent(sessionID, generation, sequence)).event
        if (event.type !== "session" && event.type !== "cortex") invalid()
        const child = event.type === "session" ? event.session.sessionID : event.sessionID
        if (!equal(row.key, [...version(sessionID, generation, event.type, child), ordinal(sequence)])) invalid()
        continue
      }
      if (row.key[4] === "parents" && row.key.length === 7) {
        const child = Child.parse(row.value).sessionID
        if (row.key[6] !== child) invalid()
        let found = false
        for (const candidate of source.entries(version(sessionID, generation, "cortex", child))) {
          const { sequence } = Sequence.parse(candidate.value)
          if (sequence > checkpoint.sequence) invalid()
          const event = source.read(Record.SharedEvent, Keys.sharedEvent(sessionID, generation, sequence)).event
          if (event.type === "cortex" && event.sessionID === child && event.parentSessionID === row.key[5]) found = true
        }
        if (!found) invalid()
        continue
      }
      invalid()
    }
  }
  async function checkpoint(sessionID: string, generation: number) {
    const value = await Record.read(Header, head(sessionID, generation))
    if (value && (value.sessionID !== sessionID || value.generation !== generation))
      fail("SERVICE_UNAVAILABLE", "Task metadata checkpoint has another owner")
    return value?.sequence ?? 0
  }
  export const parents = (sessionID: string, generation: number, parentSessionID: string) => [
    ...root(sessionID, generation),
    "parents",
    parentSessionID,
  ]

  export async function prepare(input: {
    sessionID: string
    generation: number
    watermark: number
    authorize(): Promise<unknown>
  }) {
    if (Storage.inTransaction()) fail("SERVICE_UNAVAILABLE", "Prepare shared tasks before opening their read snapshot")
    const prefix = Keys.sharedEvents(input.sessionID, input.generation)
    for (;;) {
      const current = await checkpoint(input.sessionID, input.generation)
      if (current >= input.watermark) return
      const keys = await Storage.snapshot(async () => {
        await input.authorize()
        return Storage.queryKeys({ prefix, after: [...prefix, ordinal(current)], limit: 128 })
      })
      if (!keys.length) fail("SERVICE_UNAVAILABLE", "Shared task history has an uncommitted sequence gap")
      await Storage.transaction(async () => {
        await input.authorize()
        if ((await checkpoint(input.sessionID, input.generation)) !== current) return
        let sequence = current
        for (const key of keys) {
          const stored = await Record.read(Record.SharedEvent, key)
          if (!stored) fail("SERVICE_UNAVAILABLE", "Shared task history disappeared during preparation")
          const event = stored.event
          if (event.sequence > input.watermark) break
          if (event.sequence !== sequence + 1 || key.at(-1) !== ordinal(event.sequence))
            fail("SERVICE_UNAVAILABLE", "Shared task history is not contiguous")
          sequence = event.sequence
          if (event.type !== "session" && event.type !== "cortex") continue
          const child = event.type === "session" ? event.session.sessionID : event.sessionID
          await Storage.write([...version(input.sessionID, input.generation, event.type, child), ordinal(sequence)], {
            sequence,
          })
          if (event.type === "cortex")
            await Storage.write([...parents(input.sessionID, input.generation, event.parentSessionID), child], {
              sessionID: child,
            })
        }
        if (sequence === current) fail("SERVICE_UNAVAILABLE", "Shared task preparation could not reach its checkpoint")
        await Storage.write(
          head(input.sessionID, input.generation),
          Header.parse({ version: 1, sessionID: input.sessionID, generation: input.generation, sequence }),
        )
      })
    }
  }

  async function at(
    sessionID: string,
    generation: number,
    kind: "session" | "cortex",
    child: string,
    watermark: number,
  ) {
    const prefix = version(sessionID, generation, kind, child)
    const rows = await Storage.query({
      prefix,
      after: [...prefix, ordinal(watermark) + "~"],
      descending: true,
      limit: 1,
    })
    if (!rows.length) return
    const { sequence } = Sequence.parse(rows[0]!.value)
    const stored = await Record.read(Record.SharedEvent, Keys.sharedEvent(sessionID, generation, sequence))
    if (
      !stored ||
      stored.event.type !== kind ||
      stored.event.sequence !== sequence ||
      (stored.event.type === "session" ? stored.event.session.sessionID : stored.event.sessionID) !== child
    )
      fail("SERVICE_UNAVAILABLE", "Shared task version has another canonical event")
    return stored.event
  }

  export async function page(input: {
    sessionID: string
    generation: number
    parentSessionID: string
    watermark: number
    after?: string
    limit: number
  }) {
    const prefix = parents(input.sessionID, input.generation, input.parentSessionID)
    const items: Sync.TaskSummary[] = []
    let after = input.after
    let scanned = 0
    while (scanned < 128) {
      const count = Math.min(32, 128 - scanned)
      const rows = await Storage.query({ prefix, after: after ? [...prefix, after] : undefined, limit: count + 1 })
      if (!rows.length) return { items }
      for (const row of rows.slice(0, count)) {
        const child = Child.parse(row.value).sessionID
        if (row.key.length !== prefix.length + 1 || row.key.at(-1) !== child)
          fail("SERVICE_UNAVAILABLE", "Shared task row has another child identity")
        const task = await at(input.sessionID, input.generation, "cortex", child, input.watermark)
        const source = await at(input.sessionID, input.generation, "session", child, input.watermark)
        const visible =
          task?.type === "cortex" &&
          source?.type === "session" &&
          task.parentSessionID === input.parentSessionID &&
          source.session.parentSessionID === input.parentSessionID &&
          source.session.cortex?.taskID === task.taskID &&
          source.session.cortex.parentSessionID === input.parentSessionID &&
          source.session.cortex.visibility !== "hidden"
        if (visible) {
          if (items.length === input.limit) return { items, cursor: after }
          items.push(Sync.TaskSummary.strip().parse(task))
        }
        after = child
        scanned++
      }
      if (rows.length <= count) return { items }
    }
    return { items, cursor: after }
  }
}
