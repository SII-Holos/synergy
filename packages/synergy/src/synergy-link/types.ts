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

  export const PatchInput = z
    .object({
      name: z.string().trim().min(1).max(120).optional(),
      enabled: z.boolean().optional(),
      allowedAgents: z.array(z.string().trim().min(1)).optional(),
    })
    .strict()
    .refine((value) => Object.keys(value).length > 0, "At least one field is required")
    .meta({ ref: "SynergyLinkTargetPatchInput" })
  export type PatchInput = z.infer<typeof PatchInput>

  export const Availability = z.enum(["holos_offline", "idle", "connected"])
  export type Availability = z.infer<typeof Availability>

  export const View = Info.extend({
    availability: Availability,
    sessionID: SynergyLinkIdentity.SessionID.optional(),
  }).meta({ ref: "SynergyLinkTargetView" })
  export type View = z.infer<typeof View>
}
