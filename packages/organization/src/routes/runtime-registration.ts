import { Hono } from "hono"
import { validator } from "hono-openapi"
import { z } from "zod"
import {
  OrganizationIdentity as Identity,
  OrganizationRuntimeProtocol as Runtime,
} from "@ericsanchezok/synergy-organization-protocol"
import type { RuntimeRegistrations } from "../runtime-registration"
import { operation, validation, browserCredentials } from "./shared"

const runtimeParam = z.strictObject({ runtimeID: Identity.ID })

export function registrationRoutes(registrations: () => RuntimeRegistrations, publicOrigin?: string) {
  const { credentials } = browserCredentials(publicOrigin)
  return new Hono()
    .post(
      "/runtimes/hosted",
      operation(
        "orgRuntime.registerHosted",
        "Issue an organization-hosted Runtime registration ticket",
        Runtime.Ticket,
        true,
      ),
      validator("json", Runtime.HostedRegistration, validation),
      async (c) => c.json(await registrations().hosted(credentials(c), c.req.valid("json"))),
    )
    .post(
      "/runtimes/member",
      operation("orgRuntime.registerMember", "Issue a member Runtime registration ticket", Runtime.Ticket, true),
      validator("json", Runtime.MemberRegistration, validation),
      async (c) => c.json(await registrations().member(credentials(c), c.req.valid("json"))),
    )
    .get(
      "/runtimes",
      operation("orgRuntime.list", "List authorized Runtime registrations", Runtime.RegistrationPage),
      validator("query", Identity.Page, validation),
      async (c) => c.json(await registrations().list(credentials(c), c.req.valid("query"))),
    )
    .get(
      "/runtimes/:runtimeID",
      operation("orgRuntime.get", "Read an authorized Runtime registration", Runtime.Registration),
      validator("param", runtimeParam, validation),
      async (c) => c.json(await registrations().get(credentials(c), c.req.valid("param").runtimeID)),
    )
    .post(
      "/runtimes/:runtimeID/revoke",
      operation("orgRuntime.revoke", "Revoke a Runtime registration", Runtime.Registration, true),
      validator("param", runtimeParam, validation),
      validator("json", Runtime.Revoke, validation),
      async (c) =>
        c.json(
          await registrations().revoke(
            credentials(c),
            c.req.valid("param").runtimeID,
            c.req.valid("json").expectedRevision,
          ),
        ),
    )
}

export function machineRegistrationRoutes(registrations: () => RuntimeRegistrations) {
  return new Hono().post(
    "/register",
    operation(
      "orgRuntime.consumeTicket",
      "Activate a Runtime with its one-use ticket and machine proof",
      Runtime.Registration,
      true,
    ),
    validator("json", Runtime.ConsumeTicket, validation),
    async (c) => c.json(await registrations().consume(c.req.valid("json"))),
  )
}
