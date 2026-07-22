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
      instructions: z.string().meta({ description: "Instructions for Light Loop" }),
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

const LightloopUpdateInput = z
  .object({
    instructions: z.string().meta({ description: "Updated instructions for the active Light Loop" }),
  })
  .meta({ ref: "LightloopUpdateInput" })

export const WorkflowRoute = new Hono()
  .put(
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
  .patch(
    "/session/:id/lightloop",
    describeRoute({
      summary: "Update Light Loop instructions",
      description: "Update the instructions for an active Light Loop. The next model step uses the new instructions.",
      operationId: "workflow.session.updateLightloop",
      responses: {
        200: {
          description: "Updated session",
          content: { "application/json": { schema: resolver(Session.Info) } },
        },
        ...errors(400, 404),
      },
    }),
    validator("param", z.object({ id: z.string().meta({ description: "Session ID" }) })),
    validator("json", LightloopUpdateInput),
    async (c) => {
      try {
        const session = await SessionWorkflowService.updateLightloopInstructions(
          c.req.valid("param").id,
          c.req.valid("json").instructions,
        )
        return c.json(session)
      } catch (err: any) {
        if (err instanceof Storage.NotFoundError) {
          return c.json({ message: `Session not found: ${c.req.valid("param").id}` }, 404)
        }
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )
  .post(
    "/session/:id/lightloop/cancel",
    describeRoute({
      summary: "Cancel Light Loop",
      description: "Stop active session work and completion review, then clear the Light Loop workflow.",
      operationId: "workflow.session.cancelLightloop",
      responses: {
        200: {
          description: "Updated session",
          content: { "application/json": { schema: resolver(Session.Info) } },
        },
        ...errors(400, 404),
      },
    }),
    validator("param", z.object({ id: z.string().meta({ description: "Session ID" }) })),
    async (c) => {
      try {
        return c.json(await SessionWorkflowService.cancelLightloop(c.req.valid("param").id))
      } catch (err: any) {
        if (err instanceof Storage.NotFoundError) {
          return c.json({ message: `Session not found: ${c.req.valid("param").id}` }, 404)
        }
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )
