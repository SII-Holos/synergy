import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { errors } from "./error"
import { BlueprintLoopStore, BlueprintLoopService, LoopError } from "../blueprint"
import { Info as BlueprintLoopInfoSchema } from "../blueprint/types"
import { ScopeContext } from "../scope/context"
import { Storage } from "../storage/storage"
import { Session } from "../session"

const CreateInput = z
  .object({
    noteID: z.string().meta({ description: "Note ID to loop" }),
    noteVersion: z.number().optional().meta({ description: "Note version to lock" }),
    title: z.string().meta({ description: "Loop title" }),
    description: z.string().optional().meta({ description: "Loop description" }),
    sessionID: z.string().meta({ description: "Session ID driving this loop" }),
    runMode: z.enum(["current", "new", "worktree"]).optional().meta({ description: "Loop run mode (default current)" }),
    parentSessionID: z.string().optional().meta({ description: "Parent session ID" }),
    firstPrompt: z.string().optional().meta({ description: "First user prompt for the loop" }),
    loopIndex: z.number().optional().meta({ description: "Zero-based loop index" }),
    executionAgent: z.string().optional().meta({ description: "Explicit agent override for the Blueprint Run" }),
    model: z
      .object({ providerID: z.string(), modelID: z.string() })
      .optional()
      .meta({ description: "Explicit model override for the Blueprint Run" }),
  })
  .meta({ ref: "BlueprintLoopCreateInput" })

export const BlueprintRoute = new Hono()
  .get(
    "/loop",
    describeRoute({
      summary: "List BlueprintLoops",
      description: "List all BlueprintLoops for the current scope.",
      operationId: "blueprint.loop.list",
      responses: {
        200: {
          description: "List of BlueprintLoops",
          content: { "application/json": { schema: resolver(BlueprintLoopInfoSchema.array()) } },
        },
        ...errors(400),
      },
    }),
    async (c) => {
      try {
        const loops = await BlueprintLoopStore.list(ScopeContext.current.scope.id)
        return c.json(loops)
      } catch (err: any) {
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )
  .post(
    "/loop",
    describeRoute({
      summary: "Create BlueprintLoop",
      description: "Create a new BlueprintLoop in the current scope. Returns armed status.",
      operationId: "blueprint.loop.create",
      responses: {
        200: {
          description: "Created BlueprintLoop",
          content: { "application/json": { schema: resolver(BlueprintLoopInfoSchema) } },
        },
        ...errors(400),
      },
    }),
    validator("json", CreateInput),
    async (c) => {
      try {
        const body = c.req.valid("json")
        const loop = await BlueprintLoopService.create(body)
        return c.json(loop)
      } catch (err: any) {
        if (err instanceof LoopError.AlreadyActive) {
          return c.json({ message: "This Blueprint already has an active run.", data: err.data }, 400)
        }
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )
  .post(
    "/loop/:id/complete",
    describeRoute({
      summary: "Complete BlueprintLoop",
      description: "Mark a BlueprintLoop as completed.",
      operationId: "blueprint.loop.complete",
      responses: {
        200: {
          description: "Completed BlueprintLoop",
          content: { "application/json": { schema: resolver(BlueprintLoopInfoSchema) } },
        },
        ...errors(400, 404),
      },
    }),
    validator("param", z.object({ id: z.string().meta({ description: "BlueprintLoop ID" }) })),
    async (c) => {
      try {
        const id = c.req.valid("param").id
        const loop = await BlueprintLoopStore.complete(ScopeContext.current.scope.id, id)
        return c.json(loop)
      } catch (err: any) {
        if (err instanceof Storage.NotFoundError)
          return c.json({ message: `BlueprintLoop not found: ${c.req.valid("param").id}` }, 404)
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )
  .post(
    "/loop/:id/cancel",
    describeRoute({
      summary: "Cancel BlueprintLoop",
      description: "Cancel a BlueprintLoop.",
      operationId: "blueprint.loop.cancel",
      responses: {
        200: {
          description: "Cancelled BlueprintLoop",
          content: { "application/json": { schema: resolver(BlueprintLoopInfoSchema) } },
        },
        ...errors(400, 404),
      },
    }),
    validator("param", z.object({ id: z.string().meta({ description: "BlueprintLoop ID" }) })),
    async (c) => {
      try {
        const id = c.req.valid("param").id
        const loop = await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, id, { status: "cancelled" })
        return c.json(loop)
      } catch (err: any) {
        if (err instanceof Storage.NotFoundError)
          return c.json({ message: `BlueprintLoop not found: ${c.req.valid("param").id}` }, 404)
        if (err instanceof LoopError.InvalidTransition) return c.json({ message: err.message, data: err.data }, 400)
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )
  .get(
    "/loop/:id",
    describeRoute({
      summary: "Get BlueprintLoop",
      description: "Get a specific BlueprintLoop by ID.",
      operationId: "blueprint.loop.get",
      responses: {
        200: {
          description: "BlueprintLoop",
          content: { "application/json": { schema: resolver(BlueprintLoopInfoSchema) } },
        },
        ...errors(400, 404),
      },
    }),
    validator("param", z.object({ id: z.string().meta({ description: "BlueprintLoop ID" }) })),
    async (c) => {
      try {
        const id = c.req.valid("param").id
        const loop = await BlueprintLoopStore.get(ScopeContext.current.scope.id, id)
        return c.json(loop)
      } catch (err: any) {
        if (err instanceof Storage.NotFoundError)
          return c.json({ message: `BlueprintLoop not found: ${c.req.valid("param").id}` }, 404)
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )
  .put(
    "/loop/:id/bind",
    describeRoute({
      summary: "Bind session to BlueprintLoop",
      description: "Bind the current session to a BlueprintLoop so the session drives loop execution.",
      operationId: "blueprint.loop.bind",
      responses: {
        200: {
          description: "Updated BlueprintLoop",
          content: { "application/json": { schema: resolver(BlueprintLoopInfoSchema) } },
        },
        ...errors(400, 404),
      },
    }),
    validator("param", z.object({ id: z.string().meta({ description: "BlueprintLoop ID" }) })),
    validator("json", z.object({ sessionID: z.string().meta({ description: "Session ID to bind" }) })),
    async (c) => {
      try {
        const id = c.req.valid("param").id
        const { sessionID } = c.req.valid("json")
        const loop = await BlueprintLoopStore.get(ScopeContext.current.scope.id, id)
        await BlueprintLoopService.bindSessionToLoop(sessionID, id, "execution")
        return c.json(loop)
      } catch (err: any) {
        if (err instanceof Storage.NotFoundError)
          return c.json({ message: `BlueprintLoop not found: ${c.req.valid("param").id}` }, 404)
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )
  .post(
    "/loop/:id/start",
    describeRoute({
      summary: "Start BlueprintLoop (armed → running)",
      description: "Transition a BlueprintLoop from armed to running.",
      operationId: "blueprint.loop.start",
      responses: {
        200: {
          description: "Started BlueprintLoop",
          content: { "application/json": { schema: resolver(BlueprintLoopInfoSchema) } },
        },
        ...errors(400, 404),
      },
    }),
    validator("param", z.object({ id: z.string().meta({ description: "BlueprintLoop ID" }) })),
    validator(
      "json",
      z
        .object({
          userPrompt: z
            .string()
            .optional()
            .meta({ description: "User-provided prompt to merge into execution start message" }),
        })
        .optional(),
    ),
    async (c) => {
      const id = c.req.valid("param").id
      try {
        const body = c.req.valid("json")
        const loop = await BlueprintLoopService.start(ScopeContext.current.scope.id, id, body?.userPrompt)
        return c.json(loop)
      } catch (err: any) {
        if (err instanceof Storage.NotFoundError) return c.json({ message: `BlueprintLoop not found: ${id}` }, 404)
        if (err instanceof LoopError.InvalidTransition) return c.json({ message: err.message, data: err.data }, 400)
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )
  .post(
    "/loop/:id/wait",
    describeRoute({
      summary: "Wait BlueprintLoop (running → waiting)",
      description: "Transition a BlueprintLoop from running to waiting.",
      operationId: "blueprint.loop.wait",
      responses: {
        200: {
          description: "Waiting BlueprintLoop",
          content: { "application/json": { schema: resolver(BlueprintLoopInfoSchema) } },
        },
        ...errors(400, 404),
      },
    }),
    validator("param", z.object({ id: z.string().meta({ description: "BlueprintLoop ID" }) })),
    async (c) => {
      try {
        const id = c.req.valid("param").id
        const loop = await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, id, { status: "waiting" })
        return c.json(loop)
      } catch (err: any) {
        if (err instanceof Storage.NotFoundError)
          return c.json({ message: `BlueprintLoop not found: ${c.req.valid("param").id}` }, 404)
        if (err instanceof LoopError.InvalidTransition) return c.json({ message: err.message, data: err.data }, 400)
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )
  .post(
    "/loop/:id/resume",
    describeRoute({
      summary: "Resume BlueprintLoop (waiting → running)",
      description: "Transition a BlueprintLoop from waiting back to running.",
      operationId: "blueprint.loop.resume",
      responses: {
        200: {
          description: "Resumed BlueprintLoop",
          content: { "application/json": { schema: resolver(BlueprintLoopInfoSchema) } },
        },
        ...errors(400, 404),
      },
    }),
    validator("param", z.object({ id: z.string().meta({ description: "BlueprintLoop ID" }) })),
    async (c) => {
      try {
        const id = c.req.valid("param").id
        const loop = await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, id, { status: "running" })
        return c.json(loop)
      } catch (err: any) {
        if (err instanceof Storage.NotFoundError)
          return c.json({ message: `BlueprintLoop not found: ${c.req.valid("param").id}` }, 404)
        if (err instanceof LoopError.InvalidTransition) return c.json({ message: err.message, data: err.data }, 400)
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )
  .get(
    "/loop/:id/activity",
    describeRoute({
      summary: "Get BlueprintLoop activity",
      description: "Get derived activity metrics for a BlueprintLoop (derived from session state).",
      operationId: "blueprint.loop.activity",
      responses: {
        200: {
          description: "Activity summary",
          content: {
            "application/json": {
              schema: resolver(
                z
                  .object({
                    stepCount: z.number(),
                    messageCount: z.number(),
                    lastActivityAt: z.number().optional(),
                  })
                  .meta({ ref: "BlueprintLoopActivity" }),
              ),
            },
          },
        },
        ...errors(400, 404),
      },
    }),
    validator("param", z.object({ id: z.string().meta({ description: "BlueprintLoop ID" }) })),
    async (c) => {
      try {
        await BlueprintLoopStore.get(ScopeContext.current.scope.id, c.req.valid("param").id)
        // Activity is derived from session state — not persistently stored.
        // Return zeros safely; full derivation endpoint later.
        return c.json({
          stepCount: 0,
          messageCount: 0,
          lastActivityAt: undefined,
        })
      } catch (err: any) {
        if (err instanceof Storage.NotFoundError)
          return c.json({ message: `BlueprintLoop not found: ${c.req.valid("param").id}` }, 404)
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )
  .put(
    "/session/:id/plan-mode",
    describeRoute({
      summary: "Toggle Plan Mode",
      description: "Enable or disable Plan Mode on a session.",
      operationId: "blueprint.session.planMode",
      responses: {
        200: {
          description: "Updated session",
          content: { "application/json": { schema: resolver(Session.Info) } },
        },
        ...errors(400, 404),
      },
    }),
    validator("param", z.object({ id: z.string().meta({ description: "Session ID" }) })),
    validator("json", z.object({ planMode: z.boolean().meta({ description: "Enable or disable Plan Mode" }) })),
    async (c) => {
      try {
        const id = c.req.valid("param").id
        const { planMode } = c.req.valid("json")

        if (planMode) {
          let existing: any
          try {
            existing = await Session.get(id)
          } catch (err) {
            if (err instanceof Storage.NotFoundError) return c.json({ message: `Session not found: ${id}` }, 404)
            throw err
          }
          if (existing.lightLoop?.active) {
            return c.json({ message: "Cannot enable Plan Mode while Light Loop is active" }, 400)
          }
        }

        const session = await Session.update(id, (draft) => {
          draft.planMode = planMode
        })
        return c.json(session)
      } catch (err: any) {
        if (err instanceof Storage.NotFoundError)
          return c.json({ message: `Session not found: ${c.req.valid("param").id}` }, 404)
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )

  .put(
    "/session/:id/light-loop",
    describeRoute({
      summary: "Toggle Light Loop",
      description: "Enable or disable Light Loop on a session.",
      operationId: "lightLoop.session.toggleLightLoop",
      responses: {
        200: {
          description: "Updated session",
          content: { "application/json": { schema: resolver(Session.Info) } },
        },
        ...errors(400, 404),
      },
    }),
    validator("param", z.object({ id: z.string().meta({ description: "Session ID" }) })),
    validator(
      "json",
      z.object({
        active: z.boolean().meta({ description: "Enable or disable Light Loop" }),
        taskDescription: z.string().optional().meta({ description: "Task description, required when enabling" }),
      }),
    ),
    async (c) => {
      try {
        const id = c.req.valid("param").id
        const { active, taskDescription } = c.req.valid("json")

        if (active && !taskDescription) {
          return c.json({ message: "taskDescription is required when enabling light loop" }, 400)
        }

        let existing: any
        try {
          existing = await Session.get(id)
        } catch (err) {
          if (err instanceof Storage.NotFoundError) return c.json({ message: `Session not found: ${id}` }, 404)
          throw err
        }

        if (active && existing.planMode) {
          return c.json({ message: "Cannot enable light loop while Plan Mode is active" }, 400)
        }

        if (active && existing.blueprint?.loopID) {
          return c.json({ message: "Cannot enable light loop while a BlueprintLoop is active" }, 400)
        }

        const session = await Session.update(id, (draft) => {
          draft.lightLoop = active ? { active: true, taskDescription: taskDescription! } : undefined
        })
        return c.json(session)
      } catch (err: any) {
        if (err instanceof Storage.NotFoundError)
          return c.json({ message: `Session not found: ${c.req.valid("param").id}` }, 404)
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )
