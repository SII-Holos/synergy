import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { z } from "zod"

const Lease = z.object({ token: z.string(), expiresAt: z.number() }).meta({ ref: "MaintenanceAdmissionLease" })
const Conflict = z.object({ message: z.string() })

export function MaintenanceAdmissionRoute(owner: {
  prepare(): z.infer<typeof Lease> | undefined
  release(token: string): boolean
}) {
  return new Hono()
    .post(
      "/prepare",
      describeRoute({
        summary: "Reserve an idle runtime for offline maintenance",
        description:
          "Atomically refuse active or pending work and close new mutations and session execution for 30 seconds. The desktop stops its owned server within this lease before opening storage exclusively.",
        operationId: "global.maintenancePrepare",
        responses: {
          200: { description: "Admission lease", content: { "application/json": { schema: resolver(Lease) } } },
          409: {
            description: "Runtime has active work or another lease",
            content: { "application/json": { schema: resolver(Conflict) } },
          },
        },
      }),
      (c) => {
        const lease = owner.prepare()
        return lease
          ? c.json(lease)
          : c.json({ message: "Synergy is working; wait for active tasks before maintenance" }, 409)
      },
    )
    .post(
      "/release",
      describeRoute({
        summary: "Release maintenance admission",
        operationId: "global.maintenanceRelease",
        responses: {
          200: {
            description: "Admission reopened",
            content: { "application/json": { schema: resolver(z.boolean()) } },
          },
          409: { description: "Lease does not match", content: { "application/json": { schema: resolver(Conflict) } } },
        },
      }),
      validator("json", z.object({ token: z.string() })),
      (c) =>
        owner.release(c.req.valid("json").token)
          ? c.json(true)
          : c.json({ message: "Maintenance admission lease does not match" }, 409),
    )
}
