import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import { z } from "zod"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { BusyError } from "@ericsanchezok/synergy-harness/session/error"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { SessionWorkflowService, WorkflowConflictError } from "@ericsanchezok/synergy-harness/session/workflow"
import { WorkflowKindRegistry } from "@ericsanchezok/synergy-harness/session/workflow-kind-registry"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { errors } from "../error"

export function WorkflowRoute() {
  const input = WorkflowKindRegistry.inputSchema().meta({ ref: "WorkflowSetInput" })
  const internalError = z.object({ message: z.string() }).strict().meta({ ref: "WorkflowInternalServerError" })
  return new Hono().put(
    "/session/:id",
    describeRoute({
      summary: "Set session workflow",
      description: "Enable or clear a workflow registered in this Runtime.",
      operationId: "workflow.session.set",
      responses: {
        200: { description: "Updated session", content: { "application/json": { schema: resolver(Session.Info) } } },
        ...errors(400, 404, 409),
        500: {
          description: "Internal server error",
          content: { "application/json": { schema: resolver(internalError) } },
        },
      },
    }),
    validator("param", z.object({ id: z.string().meta({ description: "Session ID" }) })),
    validator("json", input),
    async (c) => {
      const id = c.req.valid("param").id
      const value = c.req.valid("json")
      try {
        return c.json(
          Session.publicInfo(await SessionWorkflowService.set(id, { ...value, kind: z.string().parse(value.kind) })),
        )
      } catch (error) {
        if (error instanceof Storage.NotFoundError) return c.json({ message: `Session not found: ${id}` }, 404)
        if (error instanceof WorkflowConflictError)
          return c.json({ message: error.message, data: { state: error.state, reason: error.message } }, 409)
        if (error instanceof BusyError)
          return c.json({ message: error.message, data: { state: "busy", reason: error.message } }, 409)
        if (error instanceof NamedError) throw error
        return c.json({ message: "Internal server error" }, 500)
      }
    },
  )
}
