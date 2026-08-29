import { Hono, type Context } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Session } from "../session"
import { BossService } from "../boss/boss"
import { errors } from "./error"

const SessionID = z.object({ id: z.string().min(1).meta({ description: "Session ID" }) }).strict()
const BossWorkerCreateInput = z
  .object({
    role: z.string().trim().min(1).meta({ description: "Worker role label" }),
    agent: z.string().trim().min(1).optional().meta({ description: "Agent to run the worker" }),
    instructions: z.string().optional().meta({ description: "Standing instructions for the worker" }),
  })
  .strict()
  .meta({ ref: "BossWorkerCreateInput" })

const BossWorkerAssignInput = z
  .object({
    sessionID: z.string().min(1).meta({ description: "Worker session ID" }),
    taskID: z.string().trim().min(1).meta({ description: "Task ID" }),
    task: z.string().trim().min(1).meta({ description: "Task description" }),
    context: z.string().optional().meta({ description: "Additional context" }),
    acceptance: z.array(z.string()).optional().meta({ description: "Acceptance criteria" }),
  })
  .strict()
  .meta({ ref: "BossWorkerAssignInput" })

const BossWorkerCancelInput = z
  .object({
    sessionID: z.string().min(1).meta({ description: "Worker session ID" }),
    taskID: z.string().trim().min(1).optional().meta({ description: "Task ID to cancel; all tasks when omitted" }),
  })
  .strict()
  .meta({ ref: "BossWorkerCancelInput" })

const BossTreeResponse = z.object({ tree: BossService.BossTreeNodeSchema }).strict().meta({ ref: "BossTreeResponse" })

const BossErrorResponse = z
  .object({ message: z.string(), code: z.string() })
  .strict()
  .meta({ ref: "BossErrorResponse" })

function routeErrors(...codes: Array<400 | 404 | 409>) {
  return {
    ...errors(...codes),
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: resolver(BossErrorResponse) } },
    },
  }
}

function handleError(c: Context, error: unknown): Response {
  if (error instanceof BossService.BossError) {
    if (error.code === "not_found") return c.json({ message: error.message, code: error.code }, 404)
    return c.json({ message: error.message, code: error.code }, 409)
  }
  return c.json({ message: "Internal server error" }, 500)
}

export const BossRoute = new Hono()
  .get(
    "/session/:id/tree",
    describeRoute({
      summary: "Get the Boss Mode tree",
      description: "Returns the Boss Mode subtree derived from the session parent chain, rooted at the session.",
      operationId: "boss.session.tree",
      responses: {
        200: {
          description: "Boss Mode tree",
          content: { "application/json": { schema: resolver(BossTreeResponse) } },
        },
        ...routeErrors(400, 404, 409),
      },
    }),
    validator("param", SessionID),
    async (c) => {
      try {
        const callerID = c.req.valid("param").id
        return c.json({ tree: await BossService.status(callerID) })
      } catch (error) {
        return handleError(c, error)
      }
    },
  )
  .post(
    "/session/:id/worker",
    describeRoute({
      summary: "Spawn a Boss Mode worker",
      description: "Spawn a persistent specialist worker as a direct child of the boss session.",
      operationId: "boss.session.worker.create",
      responses: {
        200: {
          description: "Created worker session",
          content: { "application/json": { schema: resolver(Session.Info) } },
        },
        ...routeErrors(400, 404, 409),
      },
    }),
    validator("param", SessionID),
    validator("json", BossWorkerCreateInput),
    async (c) => {
      try {
        const callerID = c.req.valid("param").id
        return c.json(await BossService.spawn(callerID, c.req.valid("json")))
      } catch (error) {
        return handleError(c, error)
      }
    },
  )
  .post(
    "/session/:id/assign",
    describeRoute({
      summary: "Assign a task to a Boss Mode worker",
      description: "Assign a task to a direct child worker. Idempotent per (caller, taskID).",
      operationId: "boss.session.worker.assign",
      responses: {
        200: {
          description: "Assignment result",
          content: {
            "application/json": {
              schema: resolver(
                z
                  .object({
                    itemID: z.string(),
                    messageID: z.string(),
                    created: z.boolean(),
                  })
                  .strict()
                  .meta({ ref: "BossWorkerAssignResult" }),
              ),
            },
          },
        },
        ...routeErrors(400, 404, 409),
      },
    }),
    validator("param", SessionID),
    validator("json", BossWorkerAssignInput),
    async (c) => {
      try {
        const callerID = c.req.valid("param").id
        return c.json(await BossService.assign(callerID, c.req.valid("json")))
      } catch (error) {
        return handleError(c, error)
      }
    },
  )
  .post(
    "/session/:id/cancel",
    describeRoute({
      summary: "Cancel a Boss Mode task",
      description: "Cancel a task (or all tasks) assigned to a direct child worker.",
      operationId: "boss.session.worker.cancel",
      responses: {
        200: {
          description: "Cancellation result",
          content: {
            "application/json": {
              schema: resolver(z.object({ cancelled: z.boolean() }).strict().meta({ ref: "BossWorkerCancelResult" })),
            },
          },
        },
        ...routeErrors(400, 404, 409),
      },
    }),
    validator("param", SessionID),
    validator("json", BossWorkerCancelInput),
    async (c) => {
      try {
        const callerID = c.req.valid("param").id
        return c.json(await BossService.cancel(callerID, c.req.valid("json")))
      } catch (error) {
        return handleError(c, error)
      }
    },
  )
