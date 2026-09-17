import z from "zod"
import { Storage } from "../../storage/storage"
import { Lock } from "../../util/lock"
import { RolloutArtifact } from "./artifact"
import { RolloutPending } from "./pending"
import type { RolloutSchema } from "./schema"
import { record } from "./error"

export namespace RolloutJournal {
  const Revision = z.number().int().nonnegative().safe()
  // Reading the range one key at a time costs three IPC round trips per event and makes a long
  // journal the dominant storage load; one batched read per window bounds memory and round trips.
  const EVENT_READ_BATCH = 512
  const Head = z
    .object({ allocated: Revision, committed: Revision })
    .strict()
    .refine((value) => value.committed <= value.allocated, "Invalid rollout journal head")
  const identity = { version: z.literal(1), seq: Revision.positive(), time: z.number() }
  export const Event = z.discriminatedUnion("kind", [
    z
      .object({
        ...identity,
        kind: z.literal("record"),
        key: z.array(z.string().regex(/^[a-zA-Z0-9_-]+$/)).min(1),
        value: z.json(),
      })
      .strict(),
    z.object({ ...identity, kind: z.literal("gap") }).strict(),
  ])
  export type Event = z.infer<typeof Event>

  function root(owner: RolloutSchema.Owner) {
    return [...RolloutArtifact.root(owner), "journal"]
  }
  function lockKey(owner: RolloutSchema.Owner) {
    return `rollout-journal:${RolloutArtifact.root(owner).join(":")}`
  }
  function eventKey(owner: RolloutSchema.Owner, seq: number) {
    return [...root(owner), "events", String(seq).padStart(12, "0")]
  }
  export async function head(owner: RolloutSchema.Owner) {
    // Owner enumeration probes most owners without a journal; the miss is expected control flow.
    try {
      return Head.parse(await Storage.read([...root(owner), "head"], { silentNotFound: true }))
    } catch (error) {
      if (error instanceof Storage.NotFoundError) return { allocated: 0, committed: 0 }
      throw error
    }
  }

  async function recoverPending(owner: RolloutSchema.Owner, onProgress?: () => void) {
    const previous = await head(owner)
    const gaps: number[] = []
    for (let seq = previous.committed + 1; seq <= previous.allocated; seq++) {
      await Storage.transaction(async () => {
        let event: Event
        try {
          event = Event.parse(await Storage.read(eventKey(owner, seq)))
        } catch (error) {
          if (!(error instanceof Storage.NotFoundError)) throw error
          event = { version: 1, seq, time: Date.now(), kind: "gap" }
          await Storage.write(eventKey(owner, seq), event)
        }
        if (event.seq !== seq) throw new Error("Rollout journal sequence mismatch")
        if (event.kind === "record") await Storage.write([...RolloutArtifact.root(owner), ...event.key], event.value)
        else gaps.push(seq)
        await Storage.write([...root(owner), "head"], { ...previous, committed: seq })
      })
      onProgress?.()
    }
    return { recovered: previous.allocated - previous.committed, gaps }
  }

  export async function recover(owner: RolloutSchema.Owner, onProgress?: () => void) {
    using lock = await Lock.write(lockKey(owner))
    return record(() => recoverPending(owner, onProgress))
  }

  export async function write(owner: RolloutSchema.Owner, key: string[], value: unknown) {
    return record(async () => {
      const base = RolloutArtifact.root(owner)
      if (!base.every((segment, index) => key[index] === segment)) throw new Error("Rollout write escapes its owner")
      using lock = await Lock.write(lockKey(owner))
      if (Storage.inTransaction()) throw new Error("Rollout evidence requires its own commit boundary")
      await recoverPending(owner)
      const previous = await head(owner)
      const seq = Revision.parse(previous.allocated + 1)
      const event = Event.parse({
        version: 1,
        kind: "record",
        seq,
        time: Date.now(),
        key: key.slice(base.length),
        value: JSON.parse(JSON.stringify(value)),
      })
      if (event.kind !== "record") throw new Error("Invalid rollout record")
      await Storage.transaction(async () => {
        await RolloutPending.track(owner)
        await Storage.write([...root(owner), "head"], { ...previous, allocated: seq })
        await Storage.write(eventKey(owner, seq), event)
      })
      await Storage.transaction(async () => {
        await Storage.write(key, event.value)
        await Storage.write([...root(owner), "head"], { allocated: seq, committed: seq })
      })
      return seq
    })
  }
  export async function* events(owner: RolloutSchema.Owner, through: number, after = 0): AsyncGenerator<Event> {
    Revision.parse(through)
    Revision.parse(after)
    if (after > through || through > (await head(owner)).committed) throw new Error("Invalid rollout journal boundary")
    for (let start = after + 1; start <= through; start += EVENT_READ_BATCH) {
      const end = Math.min(through, start + EVENT_READ_BATCH - 1)
      const sequence: number[] = []
      for (let seq = start; seq <= end; seq++) sequence.push(seq)
      const values = await Storage.readMany<unknown>(sequence.map((seq) => eventKey(owner, seq)))
      for (const [index, seq] of sequence.entries()) {
        const value = values[index]
        // A committed event is never expected to be absent; keep the single-key read so a
        // corruption case still raises the typed miss and its storage observability issue.
        const event = Event.parse(value === undefined ? await Storage.read(eventKey(owner, seq)) : value)
        if (event.seq !== seq) throw new Error("Rollout journal sequence mismatch")
        yield event
      }
    }
  }
}
