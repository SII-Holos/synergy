import { z } from "zod"
import {
  OrganizationIdentity,
  OrganizationRuntimeProtocol as Protocol,
} from "@ericsanchezok/synergy-organization-protocol"

export const NativeHomeReaderContract = "native-organization-ownership-v5"
export const ArchivedHomeReaderContract = z.enum([
  "native-organization-ownership-v1",
  "native-organization-ownership-v2",
  "native-organization-ownership-v3",
  "native-organization-ownership-v4",
  "native-organization-ownership-v5",
])
export const MemberIdentity = z.strictObject({
  orgID: OrganizationIdentity.ID,
  accountID: OrganizationIdentity.ID,
  deviceID: OrganizationIdentity.ID,
})
export type MemberIdentity = z.infer<typeof MemberIdentity>
export const HostedIdentity = z.strictObject({ orgID: OrganizationIdentity.ID, hostID: OrganizationIdentity.ID })
export type HostedIdentity = z.infer<typeof HostedIdentity>
export const RuntimeIdentity = z.union([MemberIdentity, HostedIdentity])
export type RuntimeIdentity = z.infer<typeof RuntimeIdentity>

function binding<T extends z.ZodRawShape>(fields: T) {
  return z.discriminatedUnion("state", [
    z.strictObject({ ...fields, origin: z.string(), state: z.literal("provisioning") }),
    z.strictObject({ ...fields, origin: z.string(), state: z.literal("ready"), publicKey: Protocol.PublicKey }),
  ])
}
export const LegacyBinding = binding({ schemaVersion: z.literal(1), identity: RuntimeIdentity })
export const BeforeInitialWorkspaceBinding = binding({
  schemaVersion: z.literal(2),
  identity: RuntimeIdentity,
  readerContract: z.literal("native-organization-ownership-v3"),
})
export const BeforeDurableSyncBinding = binding({
  schemaVersion: z.literal(2),
  identity: RuntimeIdentity,
  readerContract: z.literal("native-organization-ownership-v4"),
})
export const MemberBinding = binding({
  schemaVersion: z.literal(2),
  identity: MemberIdentity,
  readerContract: z.literal(NativeHomeReaderContract),
})
export const HostedBinding = binding({
  schemaVersion: z.literal(2),
  identity: HostedIdentity,
  readerContract: z.literal(NativeHomeReaderContract),
})
export const ArchivedHostedBinding = binding({
  schemaVersion: z.literal(2),
  identity: HostedIdentity,
  readerContract: ArchivedHomeReaderContract,
})
export type ArchivedHostedBinding = z.infer<typeof ArchivedHostedBinding>
export const Binding = z.union([MemberBinding, HostedBinding])
export type Binding = z.infer<typeof Binding>
