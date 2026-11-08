import { z } from "zod"
import { OrganizationIdentity as Identity } from "./identity.js"
import { OrganizationProtocol } from "./core.js"

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
  export const View = Metadata.extend({
    permissions: z.strictObject({ read: z.literal(true), execute: z.boolean(), stop: z.boolean() }),
  }).meta({ ref: "OrgSessionDirectoryView" })
  export type View = z.infer<typeof View>
  export const Page = z
    .strictObject({ items: z.array(View), cursor: Identity.ID.optional() })
    .meta({ ref: "OrgSessionDirectoryPage" })
  export const Capacity = z
    .strictObject({ privateSessions: Identity.Revision, sharedSessions: Identity.Revision })
    .meta({ ref: "OrgSessionCapacity" })
}
