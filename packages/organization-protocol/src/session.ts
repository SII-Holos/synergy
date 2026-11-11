import { z } from "zod"
import { OrganizationIdentity as Identity } from "./identity.js"
import { OrganizationProtocol } from "./core.js"
import { OrganizationSyncProtocol as Sync } from "./sync.js"
import { OrganizationRuntimeProtocol as Runtime } from "./runtime.js"

export namespace OrganizationSessionProtocol {
  export const Binding = z
    .strictObject({
      schemaVersion: z.literal(1),
      orgID: Identity.ID,
      projectID: Identity.ID,
      creatorID: Identity.ID,
      driverRuntimeID: Identity.ID,
      bindingEpoch: z.number().int().positive(),
    })
    .meta({ ref: "OrgSessionBinding" })
  export type Binding = z.infer<typeof Binding>

  export const Metadata = OrganizationProtocol.PrivateSessionRegistration.extend({
    shareState: z.enum(["private", "shared"]),
  }).meta({ ref: "OrgSessionMetadata" })
  export type Metadata = z.infer<typeof Metadata>
  export const RuntimeView = Runtime.ConnectionStatus.extend({
    runtimeKind: z.enum(["member", "hosted"]),
    ownerID: Identity.ID.optional(),
    name: z.string().max(256).optional(),
  }).meta({ ref: "OrgSessionRuntimeSummary" })
  export const View = Metadata.extend({
    permissions: z.strictObject({ read: z.literal(true), execute: z.boolean(), stop: z.boolean() }),
    title: z.string().max(512).optional(),
    status: Sync.Status.optional(),
    sync: Sync.Share.optional(),
    runtime: RuntimeView.optional(),
  }).meta({ ref: "OrgSessionDirectoryView" })
  export type View = z.infer<typeof View>
  export const Page = z
    .strictObject({ items: z.array(View), cursor: Identity.ID.optional() })
    .meta({ ref: "OrgSessionDirectoryPage" })
  export const Capacity = z
    .strictObject({ privateSessions: Identity.Revision, sharedSessions: Identity.Revision })
    .meta({ ref: "OrgSessionCapacity" })
}
