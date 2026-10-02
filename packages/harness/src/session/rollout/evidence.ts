import { z } from "zod"
import { Storage } from "../../storage/storage"
import { RolloutSchema } from "./schema"
import { RolloutArtifact } from "./artifact"
import { RolloutLedger } from "./ledger"
import { RolloutEvents } from "./events"

export namespace RolloutEvidence {
  export const Kind = z.enum(["run", "segment", "call", "attempt", "tool", "process"])
  export type Kind = z.infer<typeof Kind>
  export const Content = z
    .object({
      mediaType: z.string(),
      text: z.string(),
      offset: z.number().int().nonnegative(),
      nextOffset: z.number().int().nonnegative().nullable(),
      bytes: z.number().int().nonnegative(),
      status: z.enum(["partial", "complete"]),
      contentVersion: z.string(),
      sha256: z.string().nullable(),
    })
    .meta({ ref: "RolloutEvidenceContent" })

  export async function record(owner: RolloutSchema.Owner, runID: string, kind: Kind, id: string, callID?: string) {
    const base = [
      ...RolloutArtifact.root(owner),
      "runs",
      z
        .string()
        .regex(/^[a-zA-Z0-9_-]+$/)
        .parse(runID),
    ]
    const validID = z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/)
      .parse(id)
    const key =
      kind === "run"
        ? [...base, "info"]
        : kind === "attempt"
          ? [
              ...base,
              "attempts",
              z
                .string()
                .regex(/^[a-zA-Z0-9_-]+$/)
                .parse(callID),
              validID,
            ]
          : [...base, kind === "process" ? "processes" : kind + "s", validID]
    const result = RolloutEvents.Record.parse({ kind, value: await Storage.read(key) })
    if (result.kind !== "run" && result.value.runID !== runID) throw new Error("Execution evidence run mismatch")
    if (result.value.id !== id) throw new Error("Execution evidence identity mismatch")
    return result
  }

  export function sources(record: RolloutEvents.Record) {
    const value = record.value
    const fields =
      record.kind === "run"
        ? ["input", "initialHistory"]
        : record.kind === "tool"
          ? ["input", "rawResult", "observation"]
          : record.kind === "process"
            ? ["stream"]
            : record.kind === "call" || record.kind === "attempt"
              ? ["request", "response"]
              : []
    return fields.flatMap((field) => {
      const ref = Reflect.get(value, field)
      const parsed = RolloutSchema.ArtifactRef.safeParse(ref)
      return parsed.success ? [{ field, artifact: parsed.data }] : []
    })
  }

  export function textBoundary(bytes: Uint8Array, limit: number) {
    if (bytes.length && (bytes[0] & 0xc0) === 0x80) throw new RangeError("Content offset splits a UTF-8 character")
    let end = Math.min(limit, bytes.length)
    while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--
    if (!end && bytes.length) {
      end = 1
      while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end++
    }
    return end
  }

  export async function source(
    owner: RolloutSchema.Owner,
    record: RolloutEvents.Record,
    field: string,
    version?: string,
  ) {
    if (JSON.stringify(record.value.owner) !== JSON.stringify(owner))
      throw new Error("Execution evidence owner mismatch")
    const saved = sources(record).find((source) => source.field === field)
    if (!saved) throw new Storage.NotFoundError({ message: "Execution content was not recorded" })
    const current = await RolloutArtifact.get(owner, saved.artifact.id)
    const ref = version
      ? RolloutSchema.ArtifactRef.parse(JSON.parse(Buffer.from(version, "base64url").toString()))
      : current
    if (
      ref.id !== current.id ||
      ref.mediaType !== current.mediaType ||
      ref.bytes > current.bytes ||
      ref.chunks > current.chunks ||
      (ref.status === "complete" && (ref.sha256 !== current.sha256 || ref.bytes !== current.bytes))
    )
      throw new RangeError("Execution content version does not match its source")
    return { ref, contentVersion: Buffer.from(JSON.stringify(ref)).toString("base64url") }
  }

  export async function stream(
    owner: RolloutSchema.Owner,
    record: RolloutEvents.Record,
    field: string,
    version?: string,
  ) {
    const value = await source(owner, record, field, version)
    return { ...value, chunks: RolloutArtifact.read(owner, value.ref) }
  }

  export async function content(
    owner: RolloutSchema.Owner,
    record: RolloutEvents.Record,
    field: string,
    offset = 0,
    limit = 65_536,
    version?: string,
  ): Promise<z.infer<typeof Content>> {
    z.number().int().nonnegative().safe().parse(offset)
    z.number().int().min(1).max(65_536).parse(limit)
    const { ref, contentVersion } = await source(owner, record, field, version)
    if (offset > ref.bytes) throw new RangeError("Content offset exceeds the recorded artifact")
    const bytes = await RolloutArtifact.readRange(owner, ref, offset, limit + 4)
    const end = textBoundary(bytes, limit)
    const next = offset + end
    return Content.parse({
      mediaType: ref.mediaType,
      text: new TextDecoder().decode(bytes.subarray(0, end)),
      offset,
      nextOffset: next < ref.bytes ? next : null,
      bytes: ref.bytes,
      status: ref.status,
      contentVersion,
      sha256: ref.sha256,
    })
  }

  export async function toolDefinitions(owner: RolloutSchema.Owner, runID: string, callID: string) {
    const call = await RolloutLedger.getCall(owner, runID, callID)
    const chunks: Uint8Array[] = []
    for await (const chunk of RolloutArtifact.read(owner, call.request)) chunks.push(chunk)
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString())
    if (!value || typeof value !== "object" || !("tools" in value)) return undefined
    return z.json().parse(value.tools)
  }
}
