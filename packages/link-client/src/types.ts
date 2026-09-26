import { SynergyLinkHost, SynergyLinkIdentity } from "@ericsanchezok/synergy-link-protocol"
import z from "zod"

export namespace SynergyLinkTarget {
  export const ID = z.string().regex(/^target_[0-9a-f-]{36}$/)
  export type ID = z.infer<typeof ID>

  export const AuthorizationState = z.enum(["unverified", "approved", "revoked"])
  export type AuthorizationState = z.infer<typeof AuthorizationState>

  export const HostObservation = SynergyLinkHost.Hello.extend({
    observedAt: z.number(),
  }).meta({ ref: "SynergyLinkHostObservation" })
  export type HostObservation = z.infer<typeof HostObservation>

  export const Probe = z
    .object({
      status: z.enum(["reachable", "refused", "busy", "failed"]),
      checkedAt: z.number(),
    })
    .meta({ ref: "SynergyLinkProbe" })
  export type Probe = z.infer<typeof Probe>

  export const Info = z
    .object({
      id: ID,
      name: z.string().trim().min(1).max(120),
      enabled: z.boolean(),
      targetAgentID: z.string().trim().min(1),
      linkID: SynergyLinkIdentity.LinkID,
      allowedAgents: z.array(z.string().trim().min(1)),
      authorization: AuthorizationState,
      host: HostObservation.optional(),
      lastProbe: Probe.optional(),
      createdAt: z.number(),
      updatedAt: z.number(),
    })
    .meta({ ref: "SynergyLinkTarget" })
  export type Info = z.infer<typeof Info>

  export const CreateInput = z
    .object({
      name: z.string().trim().min(1).max(120),
      targetAgentID: z.string().trim().min(1),
      linkID: SynergyLinkIdentity.LinkID,
      enabled: z.boolean().optional().default(true),
      allowedAgents: z.array(z.string().trim().min(1)).optional().default([]),
    })
    .strict()
    .meta({ ref: "SynergyLinkTargetCreateInput" })
  export type CreateInput = z.input<typeof CreateInput>

  const PatchName = z.object({ kind: z.literal("metadata"), name: z.string().trim().min(1).max(120) }).strict()
  const PatchEnabled = z.object({ kind: z.literal("metadata"), enabled: z.boolean() }).strict()
  const PatchAllowedAgents = z
    .object({ kind: z.literal("metadata"), allowedAgents: z.array(z.string().trim().min(1)) })
    .strict()
  const PatchNameEnabled = z
    .object({
      kind: z.literal("metadata"),
      name: z.string().trim().min(1).max(120),
      enabled: z.boolean(),
    })
    .strict()
  const PatchNameAllowedAgents = z
    .object({
      kind: z.literal("metadata"),
      name: z.string().trim().min(1).max(120),
      allowedAgents: z.array(z.string().trim().min(1)),
    })
    .strict()
  const PatchEnabledAllowedAgents = z
    .object({
      kind: z.literal("metadata"),
      enabled: z.boolean(),
      allowedAgents: z.array(z.string().trim().min(1)),
    })
    .strict()
  const PatchMetadataFields = z
    .object({
      kind: z.literal("metadata"),
      name: z.string().trim().min(1).max(120),
      enabled: z.boolean(),
      allowedAgents: z.array(z.string().trim().min(1)),
    })
    .strict()

  const PatchMetadata = z
    .union([
      PatchName,
      PatchEnabled,
      PatchAllowedAgents,
      PatchNameEnabled,
      PatchNameAllowedAgents,
      PatchEnabledAllowedAgents,
      PatchMetadataFields,
    ])
    .meta({ ref: "SynergyLinkTargetPatchMetadata" })

  const PatchRelink = z
    .object({
      kind: z.literal("relink"),
      name: z.string().trim().min(1).max(120).optional(),
      enabled: z.boolean().optional(),
      allowedAgents: z.array(z.string().trim().min(1)).optional(),
      targetAgentID: z.string().trim().min(1),
      linkID: SynergyLinkIdentity.LinkID,
    })
    .strict()
    .meta({ ref: "SynergyLinkTargetPatchRelink" })

  export const PatchInput = z
    .union([PatchMetadata, PatchRelink], {
      error: (issue) => {
        const input = issue.input
        if (typeof input !== "object" || input === null) return undefined
        const record = input as Record<string, unknown>
        if (!("kind" in record)) return 'Patch kind is required: "metadata" or "relink"'
        if (record.kind === "metadata" && Object.keys(record).length === 1) {
          return "At least one metadata field is required (name, enabled, allowedAgents)"
        }
        if (record.kind === "relink") {
          const hasTargetAgentID = "targetAgentID" in record
          const hasLinkID = "linkID" in record
          if (hasTargetAgentID !== hasLinkID) return "targetAgentID and linkID must be updated together"
        }
        if (record.kind !== "metadata" && record.kind !== "relink") {
          return `Invalid patch kind "${String(record.kind)}": expected "metadata" or "relink"`
        }
        return undefined
      },
    })
    .meta({ ref: "SynergyLinkTargetPatchInput" })
  export type PatchInput = z.infer<typeof PatchInput>

  export const Availability = z.enum(["unknown", "unreachable", "reachable", "connected"])
  export type Availability = z.infer<typeof Availability>

  export const View = Info.extend({
    availability: Availability,
    sessionID: SynergyLinkIdentity.SessionID.optional(),
  }).meta({ ref: "SynergyLinkTargetView" })
  export type View = z.infer<typeof View>
}
