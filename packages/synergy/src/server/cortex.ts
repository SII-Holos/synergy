import { Hono } from "hono"
import { describeRoute, validator } from "hono-openapi"
import { resolver } from "hono-openapi"
import { CortexTypes } from "../cortex/types"
import "../cortex/event"
import z from "zod"
import { errors } from "./error"

// Lazy import Cortex to avoid circular dependency
// (Session -> Plugin -> Server -> CortexRoute -> Cortex -> Session)
const getCortex = () => import("../cortex/manager").then((m) => m.Cortex)

export const CortexRoute = new Hono()
  .get(
    "/",
    describeRoute({
      summary: "List Cortex tasks",
      description: "List all background tasks, optionally filtered by session",
      operationId: "cortex.list",
      responses: {
        200: {
          description: "List of tasks",
          content: {
            "application/json": {
              schema: resolver(z.array(CortexTypes.Task)),
            },
          },
        },
        ...errors(400),
      },
    }),
    validator(
      "query",
      z.object({
        sessionID: z.string().optional(),
      }),
    ),
    async (c) => {
      const { sessionID } = c.req.valid("query")
      const Cortex = await getCortex()
      const tasks = sessionID ? Cortex.getTasksForSession(sessionID) : Cortex.list()
      return c.json(tasks)
    },
  )
  .get(
    "/:taskID",
    describeRoute({
      summary: "Get Cortex task",
      description: "Get a specific background task by ID",
      operationId: "cortex.get",
      responses: {
        200: {
          description: "Task details",
          content: {
            "application/json": {
              schema: resolver(CortexTypes.Task),
            },
          },
        },
        ...errors(400, 404),
      },
    }),
    validator(
      "param",
      z.object({
        taskID: z.string(),
      }),
    ),
    async (c) => {
      const { taskID } = c.req.valid("param")
      const Cortex = await getCortex()
      const task = Cortex.get(taskID)
      if (!task) {
        return c.json({ error: "Task not found" }, 404)
      }
      return c.json(task)
    },
  )
  .get(
    "/:taskID/output",
    describeRoute({
      summary: "Get task output",
      description: "Get the output of a completed background task",
      operationId: "cortex.output",
      responses: {
        200: {
          description: "Task output",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  output: z.string(),
                }),
              ),
            },
          },
        },
        ...errors(400, 404),
      },
    }),
    validator(
      "param",
      z.object({
        taskID: z.string(),
      }),
    ),
    async (c) => {
      const { taskID } = c.req.valid("param")
      const Cortex = await getCortex()
      const output = await Cortex.output(taskID)
      return c.json({ output })
    },
  )
  .post(
    "/:taskID/cancel",
    describeRoute({
      summary: "Cancel Cortex task",
      description: "Cancel a running background task",
      operationId: "cortex.cancel",
      responses: {
        200: {
          description: "Task cancelled",
          content: {
            "application/json": {
              schema: resolver(z.boolean()),
            },
          },
        },
        ...errors(400, 404),
      },
    }),
    validator(
      "param",
      z.object({
        taskID: z.string(),
      }),
    ),
    async (c) => {
      const { taskID } = c.req.valid("param")
      const Cortex = await getCortex()
      const task = Cortex.get(taskID)
      if (!task) {
        return c.json({ error: "Task not found" }, 404)
      }
      if (task.status !== "running" && task.status !== "queued") {
        return c.json({ error: "Task already completed or cancelled" }, 400)
      }
      await Cortex.cancel(taskID)
      return c.json(true)
    },
  )
