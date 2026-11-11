import { z } from "zod"
import { OrganizationIdentity as Identity } from "./identity.js"
import { OrganizationProtocol as Protocol } from "./core.js"
import { OrganizationPublicationProtocol as Publication } from "./publication.js"

export namespace OrganizationArtifactProtocol {
  export const Publish = z.strictObject({
    requestID: Identity.ID, artifactID: Identity.ID, expectedRevision: Identity.Revision,
    uploadID: Identity.ID, title: Identity.Name,
  })
  export type Publish = z.infer<typeof Publish>
  export const Version = z.strictObject({
    artifactID: Identity.ID, orgID: Identity.ID, projectID: Identity.ID, title: Identity.Name,
    version: z.number().int().positive(), revision: Identity.Revision,
    authorID: Identity.ID, publishedAt: z.number().int().nonnegative(),
    manifestHash: Protocol.Digest, fileCount: z.number().int().nonnegative().safe(),
    totalBytes: z.number().int().nonnegative().safe(),
    sourceAvailable: z.boolean(), sourceSessionID: Identity.ID.optional(),
  }).meta({ ref: "OrgArtifactVersion" })
  export type Version = z.infer<typeof Version>
  export const Query = z.strictObject({
    limit: z.coerce.number().int().min(1).max(100).default(50), cursor: Identity.ID.optional(),
  })
  export const Page = z.strictObject({ items: z.array(Version), cursor: Identity.ID.optional() })
    .meta({ ref: "OrgArtifactPage" })
  export const VersionQuery = z.strictObject({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.coerce.number().int().positive().optional(),
  })
  export const VersionPage = z.strictObject({ items: z.array(Version), cursor: z.number().int().positive().optional() })
    .meta({ ref: "OrgArtifactVersionPage" })
  export const Reference = z.strictObject({
    artifactID: Identity.ID, version: z.number().int().positive(), manifestHash: Protocol.Digest,
    projectID: Identity.ID, files: z.array(Publication.File), cursor: Protocol.Digest.optional(),
  }).meta({ ref: "OrgArtifactReference" })
}
