import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { z } from "zod"
import {
  OrganizationIdentity as Identity,
  OrganizationProtocol as Protocol,
  OrganizationSyncProtocol as Sync,
} from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationSharing as Sharing } from "../sharing"
import { fail } from "../error"
import { browserCredentials, operation, validation } from "./shared"

const target = z.strictObject({ sessionID: Identity.ID })
const blobTarget = z.strictObject({ sessionID: Identity.ID, hash: Protocol.Digest })
const blobStatusQuery = z.strictObject({ shareGeneration: z.coerce.number().int().nonnegative() })
const blobUploadQuery = blobStatusQuery.extend({
  offset: z.coerce.number().int().nonnegative().default(0),
  totalBytes: z.coerce.number().int().positive(),
})

export function sharingRoutes(publicOrigin?: string) {
  const { credentials } = browserCredentials(publicOrigin)
  return new Hono()
    .get(
      "/sessions/:sessionID/share",
      operation("orgSessions.shareState", "Read the current Session sharing generation and checkpoint", Sync.Share),
      validator("param", target, validation),
      async (c) => c.json(await Sharing.get(credentials(c), c.req.valid("param").sessionID)),
    )
    .put(
      "/sessions/:sessionID/share",
      operation("orgSessions.share", "Share a Session with its authorized project", Sync.Share, true),
      validator("param", target, validation),
      validator("json", Sync.ShareChange, validation),
      async (c) => c.json(await Sharing.share(credentials(c), c.req.valid("param").sessionID, c.req.valid("json"))),
    )
    .delete(
      "/sessions/:sessionID/share",
      operation("orgSessions.unshare", "Revoke a Session share and advance its generation", Sync.Share, true),
      validator("param", target, validation),
      validator("json", Sync.ShareChange, validation),
      async (c) => c.json(await Sharing.unshare(credentials(c), c.req.valid("param").sessionID, c.req.valid("json"))),
    )
    .post(
      "/sessions/:sessionID/sync/batches",
      operation("orgSessionSync.applyBatch", "Commit a contiguous safe Session projection batch", Sync.Ack, true),
      validator("param", target, validation),
      validator("json", Sync.Batch, validation),
      async (c) => {
        const batch = c.req.valid("json")
        if (batch.sessionID !== c.req.valid("param").sessionID)
          fail("INVALID_REQUEST", "Sync batch Session does not match its route")
        return c.json(await Sharing.applyBatch(credentials(c), batch))
      },
    )
    .get(
      "/sessions/:sessionID/sync/events",
      operation("orgSessionSync.events", "Read committed safe Session projection events", Sync.EventPage),
      validator("param", target, validation),
      validator("query", Sync.EventPageQuery, validation),
      async (c) => c.json(await Sharing.events(credentials(c), c.req.valid("param").sessionID, c.req.valid("query"))),
    )
    .get(
      "/sessions/:sessionID/blobs/:hash",
      operation("orgSessionSync.blobStatus", "Read a resumable shared Session blob checkpoint", Sync.BlobStatus),
      validator("param", blobTarget, validation),
      validator("query", blobStatusQuery, validation),
      async (c) => {
        const target = c.req.valid("param")
        const query = c.req.valid("query")
        return c.json(
          await Sharing.getBlobStatus(credentials(c), target.sessionID, {
            shareGeneration: query.shareGeneration,
            hash: target.hash,
          }),
        )
      },
    )
    .put(
      "/sessions/:sessionID/blobs/:hash",
      describeRoute({
        operationId: "orgSessionSync.uploadBlob",
        summary: "Upload one authenticated 4 MiB-or-smaller shared Session blob chunk",
        requestBody: {
          required: true,
          content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
        },
        responses: {
          200: {
            description: "Blob checkpoint",
            content: { "application/json": { schema: resolver(Sync.BlobStatus) } },
          },
        },
      }),
      validator("param", blobTarget, validation),
      validator("query", blobUploadQuery, validation),
      async (c) => {
        const target = c.req.valid("param")
        const query = c.req.valid("query")
        const body = new Uint8Array(await c.req.raw.arrayBuffer())
        return c.json(
          await Sharing.uploadBlob(credentials(c), target.sessionID, {
            shareGeneration: query.shareGeneration,
            hash: target.hash,
            offset: query.offset,
            totalBytes: query.totalBytes,
            bytes: body,
          }),
        )
      },
    )
    .get(
      "/sessions/:sessionID/blobs/:hash/content",
      describeRoute({
        operationId: "orgSessionSync.downloadBlob",
        summary: "Read a shared Session blob after authorization and hash verification",
        responses: {
          200: {
            description: "Blob bytes",
            content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
          },
        },
      }),
      validator("param", blobTarget, validation),
      validator("query", blobStatusQuery, validation),
      async (c) => {
        const target = c.req.valid("param")
        const query = c.req.valid("query")
        const bytes = await Sharing.downloadBlob(credentials(c), target.sessionID, {
          shareGeneration: query.shareGeneration,
          hash: target.hash,
        })
        return new Response(bytes, {
          headers: {
            "content-type": "application/octet-stream",
            "content-length": String(bytes.byteLength),
            etag: `"${target.hash}"`,
          },
        })
      },
    )
}
