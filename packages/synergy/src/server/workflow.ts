import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { Storage } from "../storage/storage"
import { Session } from "../session"
import { SessionWorkflowService } from "../session/workflow"
import { errors } from "./error"

const WorkflowSetInput = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("none"),
    }),
    z.object({
      kind: z.literal("plan"),
    }),
    z.object({
      kind: z.literal("lightloop"),
      taskDescription: z.string().meta({ description: "Task description for Light Loop" }),
    }),
    z.object({
      kind: z.literal("lattice"),
      mode: z.enum(["auto", "collaborative"]).meta({ description: "Lattice mode" }),
      maxModelCalls: z.number().int().min(0).optional().meta({ description: "Model-call budget; 0 means unlimited" }),
      goal: z.string().optional().meta({ description: "High-level goal for the Lattice run" }),
      action: z.enum(["continue", "restart"]).optional().meta({ description: "Resume a paused run or restart it" }),
    }),
  ])
  .meta({ ref: "WorkflowSetInput" })

export const WorkflowRoute = new Hono().put(
  "/session/:id",
  describeRoute({
    summary: "Set session workflow",
    description: "Enable or clear the mutually exclusive session workflow.",
    operationId: "workflow.session.set",
    responses: {
      200: {
        description: "Updated session",
        content: { "application/json": { schema: resolver(Session.Info) } },
      },
      ...errors(400, 404),
    },
  }),
  validator("param", z.object({ id: z.string().meta({ description: "Session ID" }) })),
  validator("json", WorkflowSetInput),
  async (c) => {
    try {
      const session = await SessionWorkflowService.set(c.req.valid("param").id, c.req.valid("json"))
      return c.json(session)
    } catch (err: any) {
      if (err instanceof Storage.NotFoundError) {
        return c.json({ message: `Session not found: ${c.req.valid("param").id}` }, 404)
      }
      return c.json({ message: err?.message ?? String(err) }, 400)
    }
  },
)
