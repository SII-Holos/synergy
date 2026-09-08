import z from "zod"
import { Storage } from "../../storage/storage"
import { Lock } from "../../util/lock"
import { RolloutArtifact } from "./artifact"
import type { RolloutSchema } from "./schema"
import { record } from "./error"

export namespace RolloutJournal {
  const options = { compact: true, durable: true, private: true } as const
  const Revision = z.number().int().nonnegative().safe()
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
    try {
      return Head.parse(await Storage.read([...root(owner), "head"]))
    } catch (error) {
      if (error instanceof Storage.NotFoundError) return { allocated: 0, committed: 0 }
      throw error
    }
  }

  async function recoverPending(owner: RolloutSchema.Owner) {
    const previous = await head(owner)
    const gaps: number[] = []
    for (let seq = previous.committed + 1; seq <= previous.allocated; seq++) {
      let event: Event
      try {
        event = Event.parse(await Storage.read(eventKey(owner, seq)))
      } catch (error) {
        if (!(error instanceof Storage.NotFoundError)) throw error
        event = { version: 1, seq, time: Date.now(), kind: "gap" }
        await Storage.write(eventKey(owner, seq), event, options)
      }
      if (event.seq !== seq) throw new Error("Rollout journal sequence mismatch")
      if (event.kind === "record") {
        await Storage.write([...RolloutArtifact.root(owner), ...event.key], event.value, options)
      } else gaps.push(seq)
    }
    if (previous.committed !== previous.allocated) {
      await Storage.write([...root(owner), "head"], { ...previous, committed: previous.allocated }, options)
    }
    return { recovered: previous.allocated - previous.committed, gaps }
  }

  export async function recover(owner: RolloutSchema.Owner) {
    using lock = await Lock.write(lockKey(owner))
    return record(() => recoverPending(owner))
  }

  export async function write(owner: RolloutSchema.Owner, key: string[], value: unknown) {
    return record(async () => {
      const base = RolloutArtifact.root(owner)
      if (!base.every((segment, index) => key[index] === segment)) throw new Error("Rollout write escapes its owner")
      using lock = await Lock.write(lockKey(owner))
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
      // Reservation prevents reuse of a sequence whose evidence survived a failed commit.
      await Storage.write([...root(owner), "head"], { ...previous, allocated: seq }, options)
      await Storage.write(eventKey(owner, seq), event, options)
      await Storage.write(key, event.value, options)
      await Storage.write([...root(owner), "head"], { allocated: seq, committed: seq }, options)
      return seq
    })
  }
  export async function* events(owner: RolloutSchema.Owner, through: number, after = 0): AsyncGenerator<Event> {
    Revision.parse(through)
    Revision.parse(after)
    if (after > through || through > (await head(owner)).committed) throw new Error("Invalid rollout journal boundary")
    for (let seq = after + 1; seq <= through; seq++) {
      const event = Event.parse(await Storage.read(eventKey(owner, seq)))
      if (event.seq !== seq) throw new Error("Rollout journal sequence mismatch")
      yield event
    }
  }
}
