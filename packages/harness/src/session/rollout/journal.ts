import z from "zod"
import { setImmediate } from "node:timers/promises"
import { Storage } from "../../storage/storage"
import { Lock } from "../../util/lock"
import { RolloutArtifact } from "./artifact"
import { RolloutPending } from "./pending"
import type { RolloutSchema } from "./schema"
import { record } from "./error"
import { UsageLedger } from "../../usage/ledger"
import { Bus } from "../../bus"
import { RolloutEvents } from "./events"
import { ScopeContext } from "../../scope/context"
import { Scope } from "../../scope"
import { Log } from "../../util/log"

export namespace RolloutJournal {
  const log = Log.create({ service: "rollout.journal" })
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
  function capture(owner: RolloutSchema.Owner, event: Extract<Event, { kind: "record" }>) {
    return Storage.enqueue(
      {
        id: crypto.randomUUID(),
        scopeID: owner.scopeID,
        type: RolloutEvents.RecordCommitted.type,
        payload: { properties: { owner, revision: event.seq, time: event.time, key: event.key, value: event.value } },
      },
      async () => {},
    )
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
        if (event.kind === "record") {
          await Storage.write([...RolloutArtifact.root(owner), ...event.key], event.value)
          await UsageLedger.capture(owner, seq, event.key, event.value)
          await UsageLedger.committed(owner, seq)
          await capture(owner, event)
        } else {
          gaps.push(seq)
          await UsageLedger.captureGap(owner, seq, event.time)
          await UsageLedger.committed(owner, seq)
        }
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

  export async function write(
    owner: RolloutSchema.Owner,
    key: string[],
    value: unknown,
    publish?: () => Promise<void>,
  ) {
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
      // One commit carries the allocation, its evidence and the projection, so
      // a crash can never expose a head that disagrees with the persisted
      // event set or leave an applied projection without its evidence.
      await Storage.transaction(async () => {
        await publish?.()
        await RolloutPending.track(owner)
        await Storage.write(eventKey(owner, seq), event)
        await Storage.write(key, event.value)
        await UsageLedger.capture(owner, seq, event.key, event.value)
        await UsageLedger.committed(owner, seq)
        await Storage.write([...root(owner), "head"], { allocated: seq, committed: seq })
        await capture(owner, event)
      })
      await ScopeContext.provide({
        scope: ScopeContext.tryScope() ?? Scope.home(),
        fn: () =>
          Bus.publish(RolloutEvents.Updated, {
            owner,
            revision: seq,
            record: RolloutEvents.parse(event.key, event.value),
          }),
      }).catch((error) => log.warn("execution notification failed", { error }))
      return seq
    })
  }
  export async function* events(owner: RolloutSchema.Owner, through: number, after = 0): AsyncGenerator<Event> {
    Revision.parse(through)
    Revision.parse(after)
    if (after > through || through > (await head(owner)).committed) throw new Error("Invalid rollout journal boundary")
    for (let start = after + 1; start <= through; start += 128) {
      const keys = Array.from({ length: Math.min(128, through - start + 1) }, (_, i) => eventKey(owner, start + i))
      const values = await Storage.readMany(keys)
      for (let i = 0; i < keys.length; i++) {
        if (values[i] === undefined)
          throw new Storage.NotFoundError({ message: "Missing committed rollout journal event" })
        const event = Event.parse(values[i])
        if (event.seq !== start + i) throw new Error("Rollout journal sequence mismatch")
        yield event
      }
      await setImmediate()
    }
  }
}
