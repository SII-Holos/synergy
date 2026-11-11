import { z } from "zod"
import { OrganizationIdentity as Identity } from "./identity.js"
import { OrganizationProtocol as Protocol } from "./core.js"
import { OrganizationResourceProtocol as Resource } from "./resource.js"

export namespace OrganizationPublicationProtocol {
  export const chunkBytes = 4 * 1024 * 1024
  export const Scope = Resource.Scope
  export type Scope = z.infer<typeof Scope>
  export const Author = z.strictObject({
    accountID: Identity.ID,
    displayName: Identity.Name,
    loginName: Identity.LoginName,
  })
  export const Path = z
    .string()
    .min(1)
    .max(4096)
    .refine(
      (value) =>
        !value.startsWith("/") &&
        !/[:\\<>"|?*\u0000-\u001f\u007f]/.test(value) &&
        value
          .split("/")
          .every(
            (segment) =>
              segment.length > 0 &&
              new TextEncoder().encode(segment).length <= 255 &&
              !/[. ]$/.test(segment) &&
              segment !== "." &&
              segment !== ".." &&
              !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment),
          ),
      "Publication paths must be relative portable paths without traversal",
    )
  export const FileInput = z.strictObject({
    path: Path,
    bytes: z.number().int().nonnegative().safe(),
    sha256: Protocol.Digest,
    mediaType: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+(?:;[\x20-\x7e]*)?$/),
  })
  export const File = FileInput.extend({ fileID: Protocol.Digest }).meta({ ref: "OrgPublicationFile" })
  export type File = z.infer<typeof File>
  export function manifestLine(file: File) {
    return JSON.stringify([file.fileID, file.path, file.bytes, file.sha256, file.mediaType]) + "\n"
  }
  export const Create = z
    .strictObject({
      requestID: Identity.ID,
      purpose: z.enum(["knowledge", "artifact"]),
      scope: Scope,
      sourceSessionID: Identity.ID.optional(),
    })
    .refine(
      (value) => value.purpose !== "artifact" || (value.scope.kind === "project" && !!value.sourceSessionID),
      "Artifact uploads require their source Session and project",
    )
  export type Create = z.infer<typeof Create>
  export const Upload = z
    .strictObject({
      uploadID: Identity.ID,
      orgID: Identity.ID,
      purpose: z.enum(["knowledge", "artifact"]),
      scope: Scope,
      sourceSessionID: Identity.ID.optional(),
      authorID: Identity.ID,
      state: z.enum(["open", "sealing", "sealed"]),
      fileCount: z.number().int().nonnegative().safe(),
      totalBytes: z.number().int().nonnegative().safe(),
      manifestHash: Protocol.Digest.optional(),
      createdAt: z.number().int().nonnegative(),
    })
    .meta({ ref: "OrgPublicationUpload" })
  export type Upload = z.infer<typeof Upload>
  export const Seal = z.strictObject({
    fileCount: z.number().int().nonnegative().safe(),
    totalBytes: z.number().int().nonnegative().safe(),
    manifestHash: Protocol.Digest.optional(),
  })
  export const PageQuery = z.strictObject({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: Protocol.Digest.optional(),
  })
  export const FilePage = z
    .strictObject({ items: z.array(File), cursor: Protocol.Digest.optional() })
    .meta({ ref: "OrgPublicationFilePage" })
  export const ChunkStatus = z
    .strictObject({
      uploadID: Identity.ID,
      fileID: Protocol.Digest,
      receivedBytes: z.number().int().nonnegative().safe(),
      bytes: z.number().int().nonnegative().safe(),
      chunkBytes: z.literal(chunkBytes),
    })
    .meta({ ref: "OrgPublicationChunkStatus" })
}
