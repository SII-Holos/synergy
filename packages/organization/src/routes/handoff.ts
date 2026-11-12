import { Hono } from "hono"
import { validator } from "hono-openapi"
import { z } from "zod"
import {
  OrganizationHandoffProtocol as Handoff,
  OrganizationHandoffObjectProtocol as Objects,
  OrganizationIdentity as Identity,
} from "@ericsanchezok/synergy-organization-protocol"
import type { Handoffs } from "../handoff"
import { fail } from "../error"
import { browserCredentials, operation, validation } from "./shared"

export function handoffRoutes(handoffs: () => Handoffs, publicOrigin?: string) {
  const { credentials } = browserCredentials(publicOrigin)
  const session = z.strictObject({ sessionID: Identity.ID })
  const target = z.strictObject({ handoffID: Identity.ID })
  return new Hono()
    .get(
      "/sessions/:sessionID/handoff-options",
      operation(
        "orgHandoff.options",
        "Inspect current Workspace references and available handoff choices",
        Handoff.Options,
      ),
      validator("param", session, validation),
      validator("query", Handoff.OptionsQuery, validation),
      async (c) =>
        c.json(
          await handoffs().options(credentials(c), c.req.valid("param").sessionID, c.req.valid("query"), {
            signal: c.req.raw.signal,
          }),
        ),
    )
    .post(
      "/sessions/:sessionID/handoffs",
      operation(
        "orgHandoff.prepare",
        "Lock the current execution binding and reserve a destination epoch",
        Handoff.View,
        true,
      ),
      validator("param", session, validation),
      validator("json", Handoff.Prepare, validation),
      async (c) =>
        c.json(await handoffs().prepare(credentials(c), c.req.valid("param").sessionID, c.req.valid("json"))),
    )
    .get(
      "/sessions/:sessionID/handoffs",
      operation("orgHandoff.list", "List handoff facts without retrying an unknown result", Handoff.Page),
      validator("param", session, validation),
      validator("query", Identity.Page, validation),
      async (c) => c.json(await handoffs().list(credentials(c), c.req.valid("param").sessionID, c.req.valid("query"))),
    )
    .get(
      "/handoffs/:handoffID",
      operation("orgHandoff.get", "Inspect the last durable handoff facts", Handoff.View),
      validator("param", target, validation),
      async (c) => c.json(await handoffs().get(credentials(c), c.req.valid("param").handoffID)),
    )
    .post(
      "/handoffs/:handoffID/accept",
      operation("orgHandoff.accept", "Accept the exact mapping plan as the destination member", Handoff.View, true),
      validator("param", target, validation),
      validator("json", Handoff.Accept, validation),
      async (c) => c.json(await handoffs().accept(credentials(c), c.req.valid("param").handoffID, c.req.valid("json"))),
    )
    .post(
      "/handoffs/:handoffID/cancel",
      operation(
        "orgHandoff.cancel",
        "Request cancellation while retaining the lock until the source proves it",
        Handoff.View,
        true,
      ),
      validator("param", target, validation),
      async (c) => c.json(await handoffs().cancel(credentials(c), c.req.valid("param").handoffID)),
    )
    .post(
      "/handoffs/:handoffID/commit",
      operation(
        "orgHandoff.commit",
        "Commit a proven source surrender and destination preparation",
        Handoff.View,
        true,
      ),
      validator("param", target, validation),
      async (c) => c.json(await handoffs().commit(credentials(c), c.req.valid("param").handoffID)),
    )
    .post(
      "/handoffs/:handoffID/permit",
      operation(
        "orgHandoff.permit",
        "Persist a separate surrender or paused activation permit",
        Handoff.SignedPermit,
        true,
      ),
      validator("param", target, validation),
      validator("json", Handoff.PermitRequest, validation),
      async (c) => c.json(await handoffs().permit(credentials(c), c.req.valid("param").handoffID, c.req.valid("json"))),
    )
    .post(
      "/handoffs/:handoffID/drive",
      operation(
        "orgHandoff.drive",
        "Drive or inspect one existing handoff participant without replaying input",
        Handoff.MachineResult,
        true,
      ),
      validator("param", target, validation),
      validator("json", Handoff.Drive, validation),
      async (c) =>
        c.json(
          await handoffs().drive(credentials(c), c.req.valid("param").handoffID, c.req.valid("json"), {
            signal: c.req.raw.signal,
          }),
        ),
    )
}

export function handoffMachineRoutes(handoffs: () => Handoffs) {
  return new Hono()
    .post(
      "/handoffs/object",
      operation(
        "orgHandoffObject.read",
        "Relay one authorized frozen package range to its destination machine",
        Handoff.ObjectChunk,
        true,
      ),
      validator("json", Objects.Request, validation),
      async (c) => {
        if (c.req.header("cookie") || c.req.header("origin"))
          fail("PERMISSION_DENIED", "Handoff objects require a machine proof")
        return c.json(await handoffs().object(c.req.valid("json"), { signal: c.req.raw.signal }))
      },
    )
    .post(
      "/handoffs/proof",
      operation("orgHandoff.proof", "Reconcile an existing machine's signed durable handoff fact", Handoff.View, true),
      validator("json", Handoff.SignedProof, validation),
      async (c) => {
        if (c.req.header("cookie") || c.req.header("origin"))
          fail("PERMISSION_DENIED", "Handoff recovery requires a machine proof")
        return c.json(await handoffs().proof(c.req.valid("json")))
      },
    )
}
