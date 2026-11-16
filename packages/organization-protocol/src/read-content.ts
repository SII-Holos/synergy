import { OrganizationReadProtocol as Read } from "./read.js"
import type { OrganizationProtocol as Protocol } from "./core.js"

export namespace OrganizationReadContent {
  export type Reference = Extract<Read.Content, { kind: "native" }>
  export type ReadField = (query: Read.Query, signal: AbortSignal) => Promise<Read.Result>
  export interface Input {
    rootSessionID: string
    sourceSessionID?: string
    messageID: string
    partID: string
    reference: Reference
    expectedBinding: Protocol.SessionBinding
    offset?: number
    signal: AbortSignal
    read: ReadField
    append(bytes: Uint8Array): Promise<void>
    hash: { update(bytes: Uint8Array): unknown; digest(): string }
  }
  export class InvalidResponse extends Error {
    readonly code = "INVALID_RESPONSE"
    constructor() {
      super("The versioned field response failed its integrity check")
      this.name = "OrganizationReadContentError"
    }
  }
  function bytes(data: string) {
    try {
      const value = data.replaceAll("-", "+").replaceAll("_", "/")
      return Uint8Array.from(atob(value + "=".repeat((4 - (value.length % 4)) % 4)), (character) =>
        character.charCodeAt(0),
      )
    } catch {
      throw new InvalidResponse()
    }
  }

  export type AttachmentInput = Omit<Input, "reference"> & { reference: Read.AttachmentReference; ordinal?: number }
  export type Ready = { state: "ready"; bytes: number; sha256: string; original: "complete" | "partial" }
  export type Preparing = {
    state: "preparing"
    offset: number
    pending: Extract<Read.Result, { operation: "partContent"; state: "preparing" }>
  }
  export type Unavailable = {
    state: "unavailable"
    offset: number
    pending: Extract<Read.Result, { operation: "attachmentContent"; state: "unavailable" }>
  }
  export function stream(input: Input): Promise<Ready | Preparing>
  export function stream(input: AttachmentInput): Promise<Ready | Unavailable>
  export function stream(input: Input | AttachmentInput): Promise<Ready | Preparing | Unavailable>
  export async function stream(input: Input | AttachmentInput): Promise<Ready | Preparing | Unavailable> {
    const reference =
      input.reference.kind === "attachment"
        ? Read.AttachmentReference.parse(input.reference)
        : Read.Content.parse(input.reference)
    if (reference.kind === "inline") throw new InvalidResponse()
    const original = reference.kind === "native" ? reference.original : "complete"
    let offset = input.offset ?? 0
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > reference.bytes) throw new InvalidResponse()
    do {
      input.signal.throwIfAborted()
      const target = {
        rootSessionID: input.rootSessionID,
        sourceSessionID: input.sourceSessionID,
        messageID: input.messageID,
        partID: input.partID,
        version: reference.version,
        offset,
      }
      const query = Read.Query.parse(
        reference.kind === "attachment"
          ? {
              ...target,
              operation: "attachmentContent",
              ...("ordinal" in input && input.ordinal !== undefined ? { ordinal: input.ordinal } : {}),
              length: Math.min(65_536, Math.max(1, reference.bytes - offset)),
            }
          : {
              ...target,
              operation: "partContent",
              field: reference.field,
              length: Math.min(128 * 1024, Math.max(1, reference.bytes - offset)),
            },
      )
      const received = await input.read(query, input.signal)
      input.signal.throwIfAborted()
      const parsed = Read.Result.safeParse(received)
      if (!parsed.success || !Read.matches(query, parsed.data, input.expectedBinding)) throw new InvalidResponse()
      let chunk: Extract<Read.Result, { operation: "attachmentContent"; state: "ready" }>["chunk"]
      if (parsed.data.operation === "partContent") {
        if (reference.kind !== "native") throw new InvalidResponse()
        if (parsed.data.state === "preparing") return { state: "preparing", offset, pending: parsed.data }
        if (!parsed.data.chunk || parsed.data.chunk.original !== reference.original) throw new InvalidResponse()
        chunk = parsed.data.chunk
      } else if (parsed.data.operation === "attachmentContent") {
        if (reference.kind !== "attachment") throw new InvalidResponse()
        if (parsed.data.state === "unavailable") return { state: "unavailable", offset, pending: parsed.data }
        if (
          parsed.data.reference.filename !== reference.filename ||
          parsed.data.reference.mediaType !== reference.mediaType
        )
          throw new InvalidResponse()
        chunk = parsed.data.chunk
      } else throw new InvalidResponse()
      if (
        chunk.totalBytes !== reference.bytes ||
        chunk.sha256 !== reference.sha256 ||
        (chunk.nextOffset <= offset && reference.bytes !== 0)
      )
        throw new InvalidResponse()
      const data = bytes(chunk.data)
      if (data.byteLength !== chunk.nextOffset - offset) throw new InvalidResponse()
      input.hash.update(data)
      await input.append(data)
      input.signal.throwIfAborted()
      offset = chunk.nextOffset
    } while (offset < reference.bytes)
    if (input.hash.digest() !== reference.sha256) throw new InvalidResponse()
    return { state: "ready", bytes: offset, sha256: reference.sha256, original }
  }
}
