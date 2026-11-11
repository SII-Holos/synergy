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

  export async function stream(input: Input) {
    const reference = Read.Content.parse(input.reference)
    if (reference.kind !== "native") throw new InvalidResponse()
    let offset = input.offset ?? 0
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > reference.bytes) throw new InvalidResponse()
    do {
      input.signal.throwIfAborted()
      const query = Read.Query.parse({
        operation: "partContent",
        rootSessionID: input.rootSessionID,
        sourceSessionID: input.sourceSessionID,
        messageID: input.messageID,
        partID: input.partID,
        field: reference.field,
        version: reference.version,
        offset,
        length: Math.min(128 * 1024, Math.max(1, reference.bytes - offset)),
      })
      const received = await input.read(query, input.signal)
      input.signal.throwIfAborted()
      const parsed = Read.Result.safeParse(received)
      if (
        !parsed.success ||
        parsed.data.operation !== "partContent" ||
        !Read.matches(query, parsed.data, input.expectedBinding)
      )
        throw new InvalidResponse()
      if (parsed.data.state === "preparing") return { state: "preparing" as const, offset, pending: parsed.data }
      const chunk = parsed.data.chunk
      if (
        !chunk ||
        chunk.totalBytes !== reference.bytes ||
        chunk.sha256 !== reference.sha256 ||
        chunk.original !== reference.original ||
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
    return { state: "ready" as const, bytes: offset, sha256: reference.sha256, original: reference.original }
  }
}
