import { z } from "zod"
import { OrganizationIdentity as Identity } from "./identity.js"

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
}
