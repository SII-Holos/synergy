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
  function view(result: Awaited<ReturnType<CommandForwarder["get"]>>) {
    const permit = result.attempt.authorization.permit
    return Command.View.parse({
      requestID: permit.requestID,
      attemptID: permit.attemptID,
      state: result.attempt.state,
      authorizedAt: permit.authorizedAt,
      result: result.attempt.result,
      accepted: result.accepted,
    })
  }
  return new Hono()
    .post(
      "/sessions/:sessionID/control",
      operation("orgCommands.control", "Pause or continue an online Session", Command.ControlAccepted, true, true),
      validator("param", z.strictObject({ sessionID: Identity.ID }), validation),
      validator("json", Command.ControlRequest, validation),
      async (c) => {
        const request = c.req.valid("json")
        if (request.sessionID !== c.req.valid("param").sessionID)
          fail("INVALID_REQUEST", "Command Session does not match its route")
        const result = await owner().control(credentials(c), request, c.req.raw.signal)
        return c.json(result.receipt, result.existing || result.receipt.effect.operation === "pause" ? 200 : 202)
      },
    )
    .post(
      "/sessions",
      operation(
        "orgSessions.create",
        "Create a private Session on an online member Runtime",
        Command.CreatedAccepted,
        true,
        true,
      ),
      validator("json", Command.CreateRequest, validation),
      async (c) => {
        const result = await owner().create(credentials(c), c.req.valid("json"), c.req.raw.signal)
        return c.json(result.receipt, result.existing ? 200 : 202)
      },
    )
    .post(
      "/sessions/:sessionID/commands",
      operation("orgCommands.input", "Submit an online Session input", Command.InputAccepted, true, true),
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
        return c.json(view(result))
      },
    )
    .get(
      "/commands/:requestID",
      operation("orgCommands.lookup", "Find the caller's command receipt by its original request ID", Command.View),
      validator("param", z.strictObject({ requestID: Identity.ID }), validation),
      async (c) => c.json(view(await owner().get(credentials(c), c.req.valid("param"), c.req.raw.signal))),
    )
}
