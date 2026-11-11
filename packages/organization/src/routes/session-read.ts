import { Hono } from "hono"
import { validator } from "hono-openapi"
import { z } from "zod"
import {
  OrganizationIdentity as Identity,
  OrganizationReadProtocol as Read,
  OrganizationInteractionProtocol as Interactions,
} from "@ericsanchezok/synergy-organization-protocol"
import type { SessionReadForwarder } from "../session-read"
import { browserCredentials, operation, validation } from "./shared"
import { fail } from "../error"

export function sessionReadRoutes(owner: () => SessionReadForwarder, publicOrigin?: string) {
  const { credentials } = browserCredentials(publicOrigin)
  return new Hono()
    .post(
      "/sessions/:sessionID/interactions",
      operation(
        "orgSessionInteractions.list",
        "Read safe pending confirmations or native winner identities without persisting their bodies",
        Interactions.Result,
        true,
      ),
      validator("param", z.strictObject({ sessionID: Identity.ID }), validation),
      validator("json", Interactions.Query, validation),
      async (c) => {
        const query = c.req.valid("json")
        if (query.rootSessionID !== c.req.valid("param").sessionID)
          fail("INVALID_REQUEST", "Interaction Session does not match its route")
        return c.json(await owner().interactions(credentials(c, "sessions.read"), query, c.req.raw.signal))
      },
    )
    .post(
      "/sessions/:sessionID/read",
      operation(
        "orgSessionRead.read",
        "Read creator-only native history through a transient authorized exchange",
        Read.Result,
        true,
      ),
      validator("param", z.strictObject({ sessionID: Identity.ID }), validation),
      validator("json", Read.Query, validation),
      async (c) => {
        const query = c.req.valid("json")
        if (query.rootSessionID !== c.req.valid("param").sessionID)
          fail("INVALID_REQUEST", "Private read Session does not match its route")
        return c.json(await owner().read(credentials(c, "sessions.read"), query, c.req.raw.signal))
      },
    )
}
