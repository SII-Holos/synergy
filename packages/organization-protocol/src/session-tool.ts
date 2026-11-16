import { z } from "zod"
import { OrganizationIdentity as Identity } from "./identity.js"
import { OrganizationExecutionProtocol as Execution } from "./execution.js"
import { OrganizationSyncProtocol as Sync } from "./sync.js"

export namespace OrganizationSessionToolProtocol {
  export const ReadQuery = z.strictObject({
    targetSessionID: Identity.ID,
    limit: z.number().int().min(0).max(50),
    offset: z.number().int().nonnegative().safe(),
    around: Identity.ID.optional(),
  })
  export type ReadQuery = z.infer<typeof ReadQuery>
  export const ReadRequest = ReadQuery.extend({ authority: Execution.DescriptionRequest }).meta({
    ref: "OrgSessionToolReadRequest",
  })
  export type ReadRequest = z.infer<typeof ReadRequest>
  export const ReadResult = z
    .strictObject({
      orgID: Identity.ID,
      callerSessionID: Identity.ID,
      rootID: Identity.ID,
      targetSessionID: Identity.ID,
      title: z.string().max(512),
      shareGeneration: Identity.Revision,
      watermark: Identity.Revision,
      items: z.array(z.strictObject({ message: Sync.MessageEvent, parts: z.array(Sync.PartEvent).max(128) })).max(50),
      partial: z.boolean(),
    })
    .meta({ ref: "OrgSessionToolReadResult" })
  export type ReadResult = z.infer<typeof ReadResult>
}
