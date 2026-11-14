import { z } from "zod"
import { RuntimeContext } from "../lifecycle/context"

export namespace SessionReadSource {
  const Query = z.strictObject({
    callerSessionID: z.string().min(1),
    targetSessionID: z.string().min(1),
    limit: z.number().int().min(0).max(50),
    offset: z.number().int().nonnegative().safe(),
    around: z.string().min(1).optional(),
  })
  export type Input = z.infer<typeof Query> & { signal: AbortSignal }
  const Result = z.strictObject({
    title: z.string(),
    output: z.string(),
    metadata: z.record(z.string(), z.unknown()),
  })
  export const Resolution = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("native") }),
    z.strictObject({ kind: z.literal("projection"), result: Result }),
  ])
  export type Resolution = z.infer<typeof Resolution>
  export interface Source {
    resolve(input: Readonly<Input>): Promise<Resolution>
  }
  const state = RuntimeContext.state(() => ({ source: undefined as Source | undefined }))

  export function register(source: Source) {
    RuntimeContext.assertCompositionOpen("Session reading source")
    if (state().source) throw new Error("Session reading source is already registered")
    state().source = { ...source }
  }

  export async function resolve(input: Input): Promise<Resolution> {
    input.signal.throwIfAborted()
    const source = state().source
    if (!source) return { kind: "native" }
    const { signal, ...request } = input
    const query = Query.parse(structuredClone(request))
    const result = await source.resolve(Object.freeze({ ...query, signal }))
    signal.throwIfAborted()
    return Resolution.parse(structuredClone(result))
  }
}
