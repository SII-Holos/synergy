import { z } from "zod"

export namespace InputAssistance {
  export const Proposal = z.object({
    producer: z.string().min(1).max(128),
    proposalID: z.string().min(1).max(256),
    generatedFingerprint: z.string(),
    acceptedFingerprint: z.string(),
  })
  export const Info = z
    .object({
      version: z.literal(1),
      proposals: z.array(Proposal).min(1).max(128),
      submittedFingerprint: z.string().optional(),
    })
    .meta({ ref: "InputAssistance" })
  export type Info = z.infer<typeof Info>
  export const Metadata = z.looseObject({ assistance: Info.optional() })

  export function read(metadata: unknown): Info | undefined {
    if (!metadata || typeof metadata !== "object" || !("assistance" in metadata)) return
    const result = Info.safeParse(metadata.assistance)
    return result.success ? result.data : undefined
  }

  // A portable diagnostic fingerprint, never an authentication or integrity check.
  export function fingerprint(text: string) {
    let hash = 0xcbf29ce484222325n
    for (const byte of new TextEncoder().encode(text)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n)
    return `fnv1a64:${hash.toString(16).padStart(16, "0")}`
  }

  export function merge(...values: Array<Info | undefined>): Info | undefined {
    const proposals = new Map<string, z.infer<typeof Proposal>>()
    for (const value of values)
      for (const proposal of value?.proposals ?? [])
        proposals.set(JSON.stringify([proposal.producer, proposal.proposalID]), proposal)
    if (!proposals.size) return
    return Info.parse({ version: 1, proposals: [...proposals.values()] })
  }

  export function accept(
    previous: Info | undefined,
    input: { producer: string; proposalID: string; generated: string; accepted: string },
  ) {
    return merge(previous, {
      version: 1,
      proposals: [
        {
          producer: input.producer,
          proposalID: input.proposalID,
          generatedFingerprint: fingerprint(input.generated),
          acceptedFingerprint: fingerprint(input.accepted),
        },
      ],
    })!
  }

  export function submit(value: Info | undefined, text: string): Info | undefined {
    return value && { ...Info.parse(value), submittedFingerprint: fingerprint(text) }
  }
}
