import { z } from "zod"
import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { Storage } from "../../storage/storage"
import { StorageIntegrityError } from "../../storage/errors"
import { RolloutArtifact } from "./artifact"
import { RolloutSchema } from "./schema"

export namespace RolloutJournalCodec {
  const identity = { seq: z.number().int().positive().safe(), time: z.number() }
  const key = z.array(z.string().regex(/^[a-zA-Z0-9_-]+$/)).min(1)
  export const Event = z.discriminatedUnion("kind", [
    z.object({ ...identity, version: z.literal(1), kind: z.literal("record"), key, value: z.json() }).strict(),
    z.object({ ...identity, version: z.literal(1), kind: z.literal("gap") }).strict(),
  ])
  export type Event = z.infer<typeof Event>
  const dynamic = {
    status: true,
    ended: true,
    request: true,
    response: true,
    httpStatus: true,
    responseModel: true,
    usage: true,
    timing: true,
    usageFinal: true,
    estimate: true,
    error: true,
  } as const
  const artifactIdentity = { version: true, id: true, mediaType: true } as const
  const ArtifactIdentity = RolloutSchema.ArtifactRef.pick(artifactIdentity)
  const ArtifactProgress = RolloutSchema.ArtifactRef.omit(artifactIdentity)
  const State = RolloutSchema.AttemptRecord.pick(dynamic).extend({
    request: ArtifactProgress,
    response: ArtifactProgress.optional(),
  })
  const Context = RolloutSchema.AttemptRecord.omit(dynamic).extend({
    request: ArtifactIdentity,
    response: ArtifactIdentity.optional(),
  })
  const Attempt = z
    .object({
      ...identity,
      version: z.literal(2),
      kind: z.literal("attempt"),
      key,
      context: z.string().regex(/^[a-f0-9]{64}$/),
      state: State,
    })
    .strict()
  const Stored = z.union([Event, Attempt])
  export type Stored = z.infer<typeof Stored>
  type Context = z.infer<typeof Context>
  const hash = (value: Context) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
  export const contextKey = (owner: RolloutSchema.Owner, id: string) => [
    ...RolloutArtifact.root(owner),
    "journal",
    "contexts",
    id,
  ]

  export function encode(event: Event): { event: Stored; context?: { id: string; value: Context } } {
    if (event.kind !== "record" || event.key.length !== 5 || event.key[0] !== "runs" || event.key[2] !== "attempts")
      return { event }
    const attempt = RolloutSchema.AttemptRecord.parse(event.value)
    const artifact = (ref: RolloutSchema.ArtifactRef | undefined, identity: boolean) =>
      ref && Object.fromEntries(Object.entries(ref).filter(([field]) => field in artifactIdentity === identity))
    const value = Context.parse({
      ...Object.fromEntries(Object.entries(attempt).filter(([field]) => !(field in dynamic))),
      request: artifact(attempt.request, true),
      ...(attempt.response ? { response: artifact(attempt.response, true) } : {}),
    })
    const state = State.parse({
      ...Object.fromEntries(Object.entries(attempt).filter(([field]) => field in dynamic)),
      request: artifact(attempt.request, false),
      ...(attempt.response ? { response: artifact(attempt.response, false) } : {}),
    })
    const id = hash(value)
    return {
      event: { version: 2, kind: "attempt", seq: event.seq, time: event.time, key: event.key, context: id, state },
      context: { id, value },
    }
  }

  export async function publishContext(owner: RolloutSchema.Owner, context: { id: string; value: Context }) {
    const key = contextKey(owner, context.id)
    const [previous] = await Storage.readMany([key])
    if (previous === undefined) await Storage.write(key, context.value)
    else if (hash(Context.parse(previous)) !== context.id)
      throw new StorageIntegrityError("Corrupt rollout journal context")
  }

  export async function decode(owner: RolloutSchema.Owner, values: unknown[]): Promise<Event[]> {
    const stored = values.map((value) => Stored.parse(value))
    const ids = [...new Set(stored.flatMap((event) => (event.version === 2 ? [event.context] : [])))]
    const contexts = ids.length ? await Storage.readMany(ids.map((id) => contextKey(owner, id))) : []
    const byID = new Map(
      ids.map((id, i) => {
        if (contexts[i] === undefined) throw new StorageIntegrityError("Missing rollout journal context")
        const value = Context.parse(contexts[i])
        if (hash(value) !== id) throw new StorageIntegrityError("Corrupt rollout journal context")
        return [id, value] as const
      }),
    )
    return stored.map((event) => {
      if (event.version === 1) return event
      const context = byID.get(event.context)!
      if (Boolean(context.response) !== Boolean(event.state.response))
        throw new StorageIntegrityError("Rollout response context mismatch")
      const value = RolloutSchema.AttemptRecord.parse({
        ...context,
        ...event.state,
        request: { ...context.request, ...event.state.request },
        ...(event.state.response ? { response: { ...context.response, ...event.state.response } } : {}),
      })
      if (
        !isDeepStrictEqual(value.owner, owner) ||
        event.key.length !== 5 ||
        event.key[0] !== "runs" ||
        event.key[1] !== value.runID ||
        event.key[2] !== "attempts" ||
        event.key[3] !== value.callID ||
        event.key[4] !== value.id
      )
        throw new StorageIntegrityError("Rollout journal context identity mismatch")
      return Event.parse({ version: 1, kind: "record", seq: event.seq, time: event.time, key: event.key, value })
    })
  }
}
