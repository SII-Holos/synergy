import { Hono } from "hono"
import { validator } from "hono-openapi"
import { z } from "zod"
import {
  OrganizationIdentity as Identity,
  OrganizationSyncProtocol as Sync,
} from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationSharing as Sharing } from "../sharing"
import { fail } from "../error"
import { browserCredentials, operation, validation } from "./shared"

const target = z.strictObject({ sessionID: Identity.ID })

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
}
