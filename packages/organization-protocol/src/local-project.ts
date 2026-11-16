import { z } from "zod"
import { OrganizationIdentity } from "./identity.js"
import { OrganizationProtocol } from "./core.js"

export namespace OrganizationLocalProjectProtocol {
  export const Summary = z
    .strictObject({
      projectID: OrganizationIdentity.ID,
      revision: OrganizationProtocol.Digest,
      binding: z
        .strictObject({
          label: z.string().min(1).max(255),
          workspaceID: OrganizationIdentity.ID,
          generation: OrganizationProtocol.Epoch,
        })
        .nullable(),
    })
    .meta({ ref: "OrgLocalProjectSummary" })
  export type Summary = z.infer<typeof Summary>
  export const Bind = z
    .strictObject({
      requestID: OrganizationIdentity.ID,
      expectedRevision: OrganizationProtocol.Digest,
      directory: z.string().min(1).max(32768),
    })
    .meta({ ref: "OrgLocalProjectBind" })
  export type Bind = z.infer<typeof Bind>
}
