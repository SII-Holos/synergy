import { z } from "zod"
import { ActorStamp } from "@ericsanchezok/synergy-util/actor-stamp"
import { OrganizationIdentity as Identity } from "./identity.js"
import { OrganizationProtocol as Protocol } from "./core.js"
import { SigningSignature, signedProtocol } from "./signature.js"

export namespace OrganizationInteractionProtocol {
  export const NativeIdentity = z.strictObject({ kind: z.enum(["permission", "question"]), requestID: Identity.ID })
  export type NativeIdentity = z.infer<typeof NativeIdentity>
  const target = { rootSessionID: Identity.ID, sourceSessionID: Identity.ID.optional() }
  export const Query = z
    .discriminatedUnion("operation", [
      z.strictObject({
        ...target,
        operation: z.literal("pending"),
        cursor: z.string().min(1).max(1024).optional(),
        limit: z.number().int().min(1).max(64).default(32),
      }),
      z
        .strictObject({
          ...target,
          operation: z.literal("decisions"),
          identities: z.array(NativeIdentity).min(1).max(32),
        })
        .refine(
          (value) =>
            new Set(value.identities.map((entry) => `${entry.kind}:${entry.requestID}`)).size ===
            value.identities.length,
          "Decision identities must be unique",
        ),
    ])
    .meta({ ref: "OrgInteractionQuery" })
  export type Query = z.infer<typeof Query>
  export const Winner = z
    .strictObject({
      sessionID: Identity.ID,
      requestID: Identity.ID,
      actor: ActorStamp.Info.optional(),
      decidedAt: z.number().int().nonnegative(),
      outcome: z.discriminatedUnion("kind", [
        z.strictObject({
          kind: z.literal("permission"),
          reply: z.enum(["once", "session", "always", "reject"]),
          causedBy: Identity.ID.optional(),
        }),
        z.strictObject({ kind: z.literal("question"), reply: z.enum(["answer", "reject"]) }),
      ]),
    })
    .meta({ ref: "OrgCommandDecisionWinner" })
  export type Winner = z.infer<typeof Winner>
  const tool = z.strictObject({ messageID: Identity.ID, callID: z.string().min(1) })
  export const Question = z.strictObject({
    question: z.string(),
    header: z.string().max(256),
    options: z.array(z.strictObject({ label: z.string(), description: z.string() })),
    multiple: z.boolean().optional(),
    allow_custom: z.boolean().optional(),
    input_type: z.enum(["text", "password"]).optional(),
  })
  export const Pending = z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("permission"),
      requestID: Identity.ID,
      sourceSessionID: Identity.ID,
      permission: z.string(),
      patterns: z.array(z.string()),
      tool: tool.optional(),
      alwaysScope: z.literal("runtime"),
    }),
    z.strictObject({
      kind: z.literal("question"),
      requestID: Identity.ID,
      sourceSessionID: Identity.ID,
      questions: z.array(Question),
      tool: tool.optional(),
      timeout: z.number().nonnegative().optional(),
      createdAt: z.number().int().nonnegative().optional(),
    }),
  ])
  export type Pending = z.infer<typeof Pending>
  const envelope = {
    rootSessionID: Identity.ID,
    sourceSessionID: Identity.ID,
    binding: Protocol.SessionBinding,
    runtimeKind: z.enum(["member", "hosted"]),
  }
  export const Decision = z.discriminatedUnion("state", [
    z.strictObject({ identity: NativeIdentity, state: z.literal("pending") }),
    z.strictObject({ identity: NativeIdentity, state: z.literal("expired") }),
    z.strictObject({ identity: NativeIdentity, state: z.literal("resolved"), winner: Winner }),
  ])
  export const Result = z
    .discriminatedUnion("operation", [
      z
        .strictObject({
          ...envelope,
          operation: z.literal("pending"),
          items: z.array(Pending).max(64),
          cursor: z.string().min(1).max(1024).optional(),
          hasMore: z.boolean(),
        })
        .refine(
          (value) => value.hasMore === (value.cursor !== undefined),
          "Pending continuation must identify its native window",
        ),
      z.strictObject({ ...envelope, operation: z.literal("decisions"), items: z.array(Decision).max(32) }),
    ])
    .meta({ ref: "OrgInteractionResult" })
  export type Result = z.infer<typeof Result>
  export const Permit = z
    .strictObject({
      schemaVersion: z.literal(1),
      purpose: z.literal("session-interactions"),
      orgID: Identity.ID,
      deploymentIncarnation: Identity.ID,
      keyID: Identity.ID,
      runtimeID: Identity.ID,
      connectionEpoch: Protocol.Epoch,
      subjectID: Identity.ID,
      binding: Protocol.SessionBinding,
      query: Query,
      issuedAt: z.number().int().nonnegative(),
      expiresAt: z.number().int().nonnegative(),
    })
    .refine(
      (value) =>
        value.orgID === value.binding.orgID &&
        value.runtimeID === value.binding.driverRuntimeID &&
        value.expiresAt > value.issuedAt &&
        value.expiresAt - value.issuedAt <= 30_000,
      "Interaction permit must bind the current Runtime and a finite window",
    )
  export type Permit = z.infer<typeof Permit>
  export const SignedPermit = z.strictObject({ permit: Permit, signature: SigningSignature })
  export type SignedPermit = z.infer<typeof SignedPermit>
  const signatures = signedProtocol(Permit, "synergy.organization.interactions.permit.v1\n")
  export const sign = signatures.sign
  export const verify = signatures.verify

  export function matches(
    query: Query,
    value: unknown,
    binding: z.infer<typeof Protocol.SessionBinding>,
  ): value is Result {
    const parsed = Result.safeParse(value)
    if (!parsed.success || new TextEncoder().encode(JSON.stringify(parsed.data)).byteLength > 512 * 1024) return false
    const result = parsed.data
    if (
      result.rootSessionID !== query.rootSessionID ||
      result.sourceSessionID !== (query.sourceSessionID ?? query.rootSessionID) ||
      JSON.stringify(result.binding) !== JSON.stringify(binding) ||
      result.operation !== query.operation
    )
      return false
    if (query.operation === "pending" && result.operation === "pending")
      return (
        result.items.length <= query.limit &&
        result.items.every((entry) => entry.sourceSessionID === result.sourceSessionID)
      )
    if (
      query.operation !== "decisions" ||
      result.operation !== "decisions" ||
      query.identities.length !== result.items.length
    )
      return false
    return result.items.every((entry, index) => {
      const expected = query.identities[index]!
      return (
        entry.identity.kind === expected.kind &&
        entry.identity.requestID === expected.requestID &&
        (entry.state !== "resolved" ||
          (entry.winner.sessionID === result.sourceSessionID &&
            entry.winner.requestID === expected.requestID &&
            entry.winner.outcome.kind === expected.kind))
      )
    })
  }
}
