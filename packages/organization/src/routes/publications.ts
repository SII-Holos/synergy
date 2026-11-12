import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { z } from "zod"
import {
  OrganizationIdentity as Identity,
  OrganizationProtocol as Protocol,
  OrganizationPublicationProtocol as Publication,
} from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationPublications as Publications } from "../publications"
import { browserCredentials, operation, validation } from "./shared"

const uploadTarget = z.strictObject({ uploadID: Identity.ID })
const fileTarget = uploadTarget.extend({ fileID: Protocol.Digest })
const chunkQuery = z.strictObject({ offset: z.coerce.number().int().nonnegative().safe() })

export function publicationRoutes(publicOrigin?: string) {
  const { credentials } = browserCredentials(publicOrigin)
  return new Hono()
    .post(
      "/publications/uploads",
      operation("orgPublications.createUpload", "Prepare an authorized publication upload", Publication.Upload, true),
      validator("json", Publication.Create, validation),
      async (c) => c.json(await Publications.create(credentials(c), c.req.valid("json"))),
    )
    .get(
      "/publications/uploads/:uploadID",
      operation("orgPublications.uploadStatus", "Read this account's publication upload", Publication.Upload),
      validator("param", uploadTarget, validation),
      async (c) => c.json(await Publications.status(credentials(c), c.req.valid("param").uploadID)),
    )
    .put(
      "/publications/uploads/:uploadID/files",
      operation("orgPublications.putFile", "Declare one immutable relative publication file", Publication.File, true),
      validator("param", uploadTarget, validation),
      validator("json", Publication.FileInput, validation),
      async (c) =>
        c.json(await Publications.putFile(credentials(c), c.req.valid("param").uploadID, c.req.valid("json"))),
    )
    .get(
      "/publications/uploads/:uploadID/files",
      operation("orgPublications.files", "Page declared publication files", Publication.FilePage),
      validator("param", uploadTarget, validation),
      validator("query", Publication.PageQuery, validation),
      async (c) =>
        c.json(await Publications.files(credentials(c), c.req.valid("param").uploadID, c.req.valid("query"))),
    )
    .put(
      "/publications/uploads/:uploadID/files/:fileID/chunks",
      describeRoute({
        operationId: "orgPublications.putChunk",
        summary: "Upload one immutable publication chunk of at most 4 MiB",
        requestBody: {
          required: true,
          content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
        },
        responses: {
          200: {
            description: "File checkpoint",
            content: { "application/json": { schema: resolver(Publication.ChunkStatus) } },
          },
        },
      }),
      validator("param", fileTarget, validation),
      validator("query", chunkQuery, validation),
      async (c) => {
        const { uploadID, fileID } = c.req.valid("param")
        return c.json(
          await Publications.putChunk(
            credentials(c),
            uploadID,
            fileID,
            c.req.valid("query").offset,
            new Uint8Array(await c.req.raw.arrayBuffer()),
          ),
        )
      },
    )
    .post(
      "/publications/uploads/:uploadID/abandon",
      operation(
        "orgPublications.abandon",
        "Abandon this author's never-verified publication upload",
        Publication.Abandonment,
        true,
      ),
      validator("param", uploadTarget, validation),
      validator("json", Publication.Abandon, validation),
      async (c) =>
        c.json(await Publications.abandon(credentials(c), c.req.valid("param").uploadID, c.req.valid("json"))),
    )
    .post(
      "/publications/uploads/:uploadID/seal",
      operation(
        "orgPublications.seal",
        "Verify every declared file and freeze the publication manifest",
        Publication.Upload,
        true,
      ),
      validator("param", uploadTarget, validation),
      validator("json", Publication.Seal, validation),
      async (c) => c.json(await Publications.seal(credentials(c), c.req.valid("param").uploadID, c.req.valid("json"))),
    )
}
