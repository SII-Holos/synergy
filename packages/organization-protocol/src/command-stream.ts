import { z } from "zod"
import { OrganizationCommandProtocol as Command } from "./command.js"
import { OrganizationIdentity as Identity } from "./identity.js"
import { OrganizationProtocol as Protocol } from "./core.js"
import { OrganizationRuntimeProtocol as Runtime } from "./runtime.js"

export namespace OrganizationCommandStream {
  export const Header = Command.InputRequest.omit({ input: true })
  export const Begin = z
    .strictObject({
      type: z.literal("begin"),
      requestID: Identity.ID,
      connectionID: Identity.Token,
      operation: z.enum(["input", "decision"]),
      header: Header,
      bytes: z.number().int().positive().safe(),
      sha256: Protocol.Digest,
    })
    .refine(
      (value) => value.bytes <= (value.operation === "input" ? Command.inputByteLimit : Command.decisionByteLimit),
      "Command stream exceeds its canonical payload limit",
    )
  export type Begin = z.infer<typeof Begin>
  export const Chunk = z.strictObject({
    type: z.literal("chunk"),
    requestID: Identity.ID,
    connectionID: Identity.Token,
    offset: z.number().int().nonnegative().safe(),
    data: Runtime.CommandChunk.shape.data,
  })
  export type Chunk = z.infer<typeof Chunk>
  export const Finish = z.strictObject({
    type: z.literal("finish"),
    requestID: Identity.ID,
    connectionID: Identity.Token,
  })
  export type Finish = z.infer<typeof Finish>
  export const Frame = z.discriminatedUnion("type", [Begin, Chunk, Finish])
  export type Frame = z.infer<typeof Frame>
  export const Progress = z.strictObject({
    kind: z.literal("progress"),
    requestID: Identity.ID,
    nextOffset: z.number().int().nonnegative().safe(),
  })
  export type Progress = z.infer<typeof Progress>
  export function serialize(value: Command.InputRequest | Command.DecisionRequest) {
    const request = Command.InputRequest.or(Command.DecisionRequest).parse(value)
    if ("input" in request) {
      const { input, ...header } = request
      return { operation: "input" as const, header, payload: new TextEncoder().encode(JSON.stringify(input)) }
    }
    const { decision, ...header } = request
    return { operation: "decision" as const, header, payload: new TextEncoder().encode(JSON.stringify(decision)) }
  }
  export function encodeChunk(bytes: Uint8Array): string {
    if (!bytes.byteLength || bytes.byteLength > Runtime.commandChunkBytes)
      throw new Error("The command chunk size is invalid")
    return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")
  }
}
