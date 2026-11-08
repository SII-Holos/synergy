import { Hono } from "hono"
import { validator } from "hono-openapi"
import { z } from "zod"
import {
  OrganizationCommandProtocol as Command,
  OrganizationIdentity as Identity,
} from "@ericsanchezok/synergy-organization-protocol"
import type { CommandForwarder } from "../command-forwarding"
import { fail } from "../error"
import { browserCredentials, operation, validation } from "./shared"

export function commandRoutes(owner: () => CommandForwarder, publicOrigin?: string) {
  const { credentials } = browserCredentials(publicOrigin)
  return new Hono()
    .post(
      "/sessions/:sessionID/commands",
      operation("orgCommands.input", "Submit an online Session input", Command.Accepted, true, true),
      validator("param", z.strictObject({ sessionID: Identity.ID }), validation),
      validator("json", Command.InputRequest, validation),
      async (c) => {
        const request = c.req.valid("json")
        if (request.sessionID !== c.req.valid("param").sessionID)
          fail("INVALID_REQUEST", "Command Session does not match its route")
        const result = await owner().input(credentials(c), request, c.req.raw.signal)
        return c.json(result.receipt, result.existing ? 200 : 202)
      },
    )
    .get(
      "/sessions/:sessionID/commands/:requestID",
      operation("orgCommands.get", "Query the caller's existing command receipt", Command.View),
      validator("param", z.strictObject({ sessionID: Identity.ID, requestID: Identity.ID }), validation),
      async (c) => {
        const result = await owner().get(credentials(c), c.req.valid("param"), c.req.raw.signal)
        const permit = result.attempt.authorization.permit
        return c.json(
          Command.View.parse({
            requestID: permit.requestID,
            attemptID: permit.attemptID,
            state: result.attempt.state,
            authorizedAt: permit.authorizedAt,
            result: result.attempt.result,
            accepted: result.accepted,
          }),
        )
      },
    )
}
