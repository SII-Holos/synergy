import { z } from "zod"
import { OrganizationIdentity as Identity } from "./identity.js"
import { OrganizationProtocol as Protocol } from "./core.js"
import { OrganizationSyncProtocol as Sync } from "./sync.js"
import { SigningSignature, signedProtocol } from "./signature.js"

export namespace OrganizationReadProtocol {
  const target = { rootSessionID: Identity.ID, sourceSessionID: Identity.ID.optional() }
  const cursor = z.string().min(1).max(8192)
  export const Field = z.enum(["text", "input", "output", "error"])
  export const Query = z
    .discriminatedUnion("operation", [
      z.strictObject({ ...target, operation: z.literal("session") }),
      z.strictObject({
        ...target,
        operation: z.literal("tasks"),
        cursor: cursor.optional(),
        limit: z.number().int().min(1).max(64).default(32),
      }),
      z.strictObject({
        ...target,
        operation: z.literal("timeline"),
        cursor: cursor.optional(),
        limit: z.number().int().min(1).max(64).default(32),
      }),
      z.strictObject({
        ...target,
        operation: z.literal("parts"),
        messageID: Identity.ID,
        cursor: cursor.optional(),
        limit: z.number().int().min(1).max(128).default(64),
      }),
      z.strictObject({
        ...target,
        operation: z.literal("partContent"),
        messageID: Identity.ID,
        partID: Identity.ID,
        field: Field.default("text"),
        version: z.string().min(1).max(512).optional(),
        offset: z.number().int().nonnegative().safe().default(0),
        length: z
          .number()
          .int()
          .min(1)
          .max(128 * 1024)
          .default(64 * 1024),
      }),
      z.strictObject({ ...target, operation: z.literal("status") }),
      z.strictObject({
        ...target,
        operation: z.literal("attachmentContent"),
        messageID: Identity.ID,
        partID: Identity.ID,
        version: z.string().min(1).max(512),
        offset: z.number().int().nonnegative().safe().default(0),
        length: z.number().int().min(1).max(65_536).default(65_536),
      }),
    ])
    .meta({ ref: "OrgPrivateReadQuery" })
  export type Query = z.infer<typeof Query>
  export type Input = z.input<typeof Query>

  export const Permit = z
    .strictObject({
      purpose: z.literal("session-read"),
      schemaVersion: z.literal(1),
      orgID: Identity.ID,
      deploymentIncarnation: Identity.ID,
      runtimeID: Identity.ID,
      projectID: Identity.ID,
      creatorID: Identity.ID,
      subjectID: Identity.ID,
      keyID: Identity.ID,
      bindingEpoch: Protocol.Epoch,
      connectionEpoch: Protocol.Epoch,
      query: Query,
      issuedAt: z.number().int().nonnegative(),
      expiresAt: z.number().int().nonnegative(),
    })
    .refine(
      (value) => value.expiresAt > value.issuedAt && value.expiresAt - value.issuedAt <= 30_000,
      "Read authority requires a finite window",
    )
  export type Permit = z.infer<typeof Permit>
  export const SignedPermit = z.strictObject({ permit: Permit, signature: SigningSignature })
  export type SignedPermit = z.infer<typeof SignedPermit>
  const signatures = signedProtocol(Permit, "synergy.organization.session-read.v1\n")
  export const publicKey = signatures.publicKey
  export const sign = signatures.sign
  export const verify = signatures.verify

  export const Content = z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("inline"),
      text: z
        .string()
        .refine(
          (value) => new TextEncoder().encode(value).byteLength <= 2048,
          "Native inline content exceeds its display window",
        ),
    }),
    z.strictObject({
      kind: z.literal("native"),
      version: z.string().min(1).max(512),
      field: Field,
      bytes: z.number().int().nonnegative().safe(),
      sha256: Protocol.Digest,
      original: z.enum(["complete", "partial"]),
    }),
  ])
  export type Content = z.infer<typeof Content>
  export const AttachmentReference = z
    .strictObject({
      kind: z.literal("attachment"),
      version: z.string().min(1).max(512),
      filename: z
        .string()
        .min(1)
        .max(512)
        .regex(/^[^/\\\u0000]+$/)
        .refine((value) => value !== "." && value !== ".."),
      mediaType: z.string().min(1).max(256),
      bytes: z.number().int().nonnegative().safe(),
      sha256: Protocol.Digest,
    })
    .meta({ ref: "OrgPrivateAttachmentReference" })
  export type AttachmentReference = z.infer<typeof AttachmentReference>
  export const Part = z.strictObject({
    partID: Identity.ID,
    messageID: Identity.ID,
    version: z.string().min(1).max(512),
    part: Sync.transcriptPartSchema(Content),
  })
  export type Part = z.infer<typeof Part>
  export const Message = Sync.MessageEvent.omit({
    type: true,
    sequence: true,
    sessionID: true,
    integrity: true,
    removed: true,
  }).extend({
    summary: z.string().max(512),
    error: z.strictObject({ code: z.string().max(256), message: z.string().max(2048) }).optional(),
    version: z.string().min(1).max(512),
    order: z.string().min(1).max(512),
  })
  export type Message = z.infer<typeof Message>
  export const PartSummary = z.strictObject({
    partID: Identity.ID,
    messageID: Identity.ID,
    type: z.string().min(1).max(256),
    preview: z.string().max(512),
    render: z.boolean().optional(),
    status: z.string().max(256).optional(),
    tool: z.string().max(256).optional(),
    content: z.strictObject({ version: z.string().min(1).max(512), bytes: z.number().int().nonnegative().safe() }),
  })
  const envelope = { rootSessionID: Identity.ID, sourceSessionID: Identity.ID, binding: Protocol.SessionBinding }
  export const Chunk = z
    .strictObject({
      field: Field,
      offset: z.number().int().nonnegative().safe(),
      nextOffset: z.number().int().nonnegative().safe(),
      totalBytes: z.number().int().nonnegative().safe(),
      sha256: Protocol.Digest,
      original: z.enum(["complete", "partial"]),
      data: z
        .string()
        .regex(/^[A-Za-z0-9_-]*$/)
        .max(174_763),
      complete: z.boolean(),
    })
    .refine(
      (value) =>
        value.offset <= value.nextOffset &&
        value.nextOffset <= value.totalBytes &&
        value.nextOffset - value.offset === Math.floor((value.data.length * 3) / 4) &&
        value.complete === (value.nextOffset === value.totalBytes),
      "Content bytes must match their declared window",
    )
  export const AttachmentChunk = z
    .strictObject({
      offset: z.number().int().nonnegative().safe(),
      nextOffset: z.number().int().nonnegative().safe(),
      totalBytes: z.number().int().nonnegative().safe(),
      sha256: Protocol.Digest,
      data: z
        .string()
        .regex(/^[A-Za-z0-9_-]*$/)
        .max(87_382),
      complete: z.boolean(),
    })
    .refine(
      (value) =>
        value.offset <= value.nextOffset &&
        value.nextOffset <= value.totalBytes &&
        value.nextOffset - value.offset === Math.floor((value.data.length * 3) / 4) &&
        value.complete === (value.nextOffset === value.totalBytes),
      "Attachment bytes must match their declared window",
    )
    .meta({ ref: "OrgPrivateAttachmentChunk" })
  export const Result = z
    .discriminatedUnion("operation", [
      z
        .strictObject({
          ...envelope,
          operation: z.literal("tasks"),
          items: z.array(Sync.TaskSummary).max(64),
          total: z.number().int().nonnegative().safe(),
          cursor: cursor.optional(),
        })
        .refine((value) => value.total >= value.items.length, "Task counts cannot omit returned rows"),
      z.strictObject({
        ...envelope,
        operation: z.literal("session"),
        session: z.strictObject({
          sessionID: Identity.ID,
          parentSessionID: Identity.ID.optional(),
          title: z.string().max(512),
          createdAt: z.number().int().nonnegative(),
          updatedAt: z.number().int().nonnegative(),
        }),
      }),
      z.strictObject({
        ...envelope,
        operation: z.literal("timeline"),
        items: z.array(Message).max(64),
        referencedRoots: z.array(Message).max(64),
        cursor: cursor.optional(),
        hasMore: z.boolean(),
        total: z.number().int().nonnegative(),
        generation: z.number().int().nonnegative(),
      }),
      z.strictObject({
        ...envelope,
        operation: z.literal("parts"),
        messageID: Identity.ID,
        items: z.array(PartSummary).max(128),
        cursor: cursor.optional(),
        hasMore: z.boolean(),
        generation: z.number().int().nonnegative().optional(),
      }),
      z.discriminatedUnion("state", [
        z.strictObject({
          ...envelope,
          operation: z.literal("partContent"),
          state: z.literal("ready").default("ready"),
          value: Part,
          chunk: Chunk.optional(),
        }),
        z.strictObject({
          ...envelope,
          operation: z.literal("partContent"),
          state: z.literal("preparing"),
          messageID: Identity.ID,
          partID: Identity.ID,
          version: z.string().min(1).max(512),
          progress: z.strictObject({
            phase: z.enum(["queued", "materializing", "busy"]),
            bytes: z.number().int().nonnegative().safe(),
            totalBytes: z.number().int().nonnegative().safe().optional(),
          }),
        }),
      ]),
      z.strictObject({ ...envelope, operation: z.literal("status"), status: Sync.Status }),
      z.discriminatedUnion("state", [
        z.strictObject({
          ...envelope,
          operation: z.literal("attachmentContent"),
          messageID: Identity.ID,
          partID: Identity.ID,
          state: z.literal("ready"),
          reference: AttachmentReference,
          chunk: AttachmentChunk,
        }),
        z.strictObject({
          ...envelope,
          operation: z.literal("attachmentContent"),
          messageID: Identity.ID,
          partID: Identity.ID,
          state: z.literal("unavailable"),
          version: z.string().min(1).max(512),
          reason: z.enum(["not_retained", "partial"]),
        }),
      ]),
    ])
    .meta({ ref: "OrgPrivateReadResult" })
  export type Result = z.infer<typeof Result>

  export const responseBytes = 512 * 1024
  export function bindingFor(permit: Permit): Protocol.SessionBinding {
    return Protocol.SessionBinding.parse({
      schemaVersion: 1,
      orgID: permit.orgID,
      projectID: permit.projectID,
      creatorID: permit.creatorID,
      driverRuntimeID: permit.runtimeID,
      bindingEpoch: permit.bindingEpoch,
    })
  }
  export function matches(query: Query, result: Result, expected?: Protocol.SessionBinding) {
    if (
      result.operation !== query.operation ||
      result.rootSessionID !== query.rootSessionID ||
      result.sourceSessionID !== (query.sourceSessionID ?? query.rootSessionID) ||
      new TextEncoder().encode(JSON.stringify(result)).byteLength > responseBytes
    )
      return false
    if (
      expected &&
      JSON.stringify(Protocol.SessionBinding.parse(result.binding)) !==
        JSON.stringify(Protocol.SessionBinding.parse(expected))
    )
      return false
    if (query.operation === "session" && result.operation === "session")
      return result.session.sessionID === result.sourceSessionID
    if (query.operation === "timeline" && result.operation === "timeline") return result.items.length <= query.limit
    if (query.operation === "tasks" && result.operation === "tasks")
      return (
        result.items.length <= query.limit &&
        new Set(result.items.map((item) => item.sessionID)).size === result.items.length &&
        result.items.every(
          (item) => item.parentSessionID === result.sourceSessionID && item.sessionID !== result.sourceSessionID,
        )
      )
    if (query.operation === "parts" && result.operation === "parts")
      return (
        result.messageID === query.messageID &&
        result.items.length <= query.limit &&
        result.items.every((item) => item.messageID === query.messageID)
      )
    if (query.operation === "attachmentContent" && result.operation === "attachmentContent") {
      if (result.messageID !== query.messageID || result.partID !== query.partID) return false
      if (result.state === "unavailable") return result.version === query.version
      return (
        result.reference.version === query.version &&
        result.chunk.offset === query.offset &&
        result.chunk.nextOffset - result.chunk.offset <= query.length &&
        result.chunk.totalBytes === result.reference.bytes &&
        result.chunk.sha256 === result.reference.sha256
      )
    }
    if (query.operation !== "partContent" || result.operation !== "partContent") return true
    if (result.state === "preparing")
      return (
        result.messageID === query.messageID &&
        result.partID === query.partID &&
        (query.version === undefined || query.version === result.version)
      )
    if (
      result.value.partID !== query.partID ||
      result.value.messageID !== query.messageID ||
      (query.version !== undefined && result.value.version !== query.version)
    )
      return false
    const chunk = result.chunk
    if (!chunk) return true
    if (chunk.field !== query.field || chunk.offset !== query.offset || chunk.nextOffset - chunk.offset > query.length)
      return false
    const part = result.value.part
    const references =
      part.type === "tool" ? [part.input, part.output, part.error] : "content" in part ? [part.content] : []
    return references.some(
      (ref) =>
        ref?.kind === "native" &&
        ref.version === result.value.version &&
        ref.field === chunk.field &&
        ref.bytes === chunk.totalBytes &&
        ref.sha256 === chunk.sha256 &&
        ref.original === chunk.original,
    )
  }
}
