import { z } from "zod"
import { OrganizationIdentity, OrganizationRuntimeProtocol } from "@ericsanchezok/synergy-organization-protocol"
import { MemberIdentity } from "./home.js"

export const MemberListener = z.strictObject({
  port: z.number().int().min(1).max(65535),
  token: z.string().regex(/^[a-f0-9]{64}$/),
})

export const MemberDesktop = z.strictObject({ browserToken: z.string().regex(/^[a-f0-9]{64}$/) })
export const MemberDesktopEntry = z.enum(["desktop-managed", "dev-desktop-managed"])

export const MemberLaunchRequest = z.strictObject({
  version: z.literal(1),
  identity: MemberIdentity,
  deploymentIncarnation: OrganizationIdentity.ID,
  ...MemberListener.shape,
  desktop: MemberDesktop.optional(),
  ticket: OrganizationRuntimeProtocol.Ticket.optional(),
  ca: z
    .string()
    .min(1)
    .max(32 * 1024)
    .optional(),
})
export type MemberLaunchRequest = z.infer<typeof MemberLaunchRequest>
