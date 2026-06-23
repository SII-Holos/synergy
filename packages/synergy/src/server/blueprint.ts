import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { Identifier } from "../id/id"
import { errors } from "./error"
import { BlueprintLoopStore, LoopError } from "../blueprint"
import { Info as BlueprintLoopInfoSchema } from "../blueprint/types"
import { Instance } from "../scope/instance"
import { Storage } from "../storage/storage"
import { Session } from "../session"
import { SessionManager } from "../session/manager"
import { MessageV2 } from "../session/message-v2"

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
  })
  .meta({ ref: "BlueprintLoopCreateInput" })

function defaultFirstPrompt(loop: { title: string; noteID: string }) {
  return `Execute the "${loop.title}" blueprint (note ID: ${loop.noteID}).
Before doing any implementation work, call blueprint_read with noteID=${loop.noteID} to read the full Blueprint content.
Continue working until fully implemented.
When the blueprint is ready for audit, call blueprint_loop_finish with status="auditing".
If the task is blocked beyond recovery, call blueprint_loop_finish with status="failed".`
}

async function bindSessionToLoop(sessionID: string, loopID: string) {
  await Session.update(sessionID, (draft) => {
    draft.blueprint = { ...draft.blueprint, loopID }
  })
}

async function deliverFirstPrompt(
  sessionID: string,
  loop: { id: string; noteID: string; title: string; firstPrompt?: string },
  userPrompt?: string,
) {
  let text = loop.firstPrompt?.trim() || defaultFirstPrompt(loop)
  if (userPrompt?.trim()) {
    text += `\n\nUser instruction:\n${userPrompt.trim()}`
  }
  const textPart: MessageV2.TextPart = {
    id: Identifier.ascending("part"),
    sessionID,
    messageID: Identifier.ascending("message"),
    type: "text",
    text,
  }
  const mail: SessionManager.SessionMail.User = {
    type: "user",
    parts: [textPart],
    metadata: {
      mailbox: true,
      source: "blueprint_loop_start",
      loopID: loop.id,
    },
  }
  await SessionManager.deliver({ target: sessionID, mail })
}

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
        const loops = await BlueprintLoopStore.list(Instance.scope.id)
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
        const loop = await BlueprintLoopStore.create({
          ...body,
          runMode: body.runMode ?? "current",
        })
        return c.json(loop)
      } catch (err: any) {
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
        const loop = await BlueprintLoopStore.complete(Instance.scope.id, id)
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
        const loop = await BlueprintLoopStore.updateStatus(Instance.scope.id, id, { status: "cancelled" })
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
        const loop = await BlueprintLoopStore.get(Instance.scope.id, id)
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
        const loop = await BlueprintLoopStore.get(Instance.scope.id, id)
        await bindSessionToLoop(sessionID, id)
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
      let started = false
      try {
        const body = c.req.valid("json")
        const before = await BlueprintLoopStore.get(Instance.scope.id, id)
        const loop = await BlueprintLoopStore.updateStatus(Instance.scope.id, id, { status: "running" })
        started = true
        await bindSessionToLoop(before.sessionID, id)
        await deliverFirstPrompt(before.sessionID, before, body?.userPrompt)
        return c.json(loop)
      } catch (err: any) {
        if (started) {
          await BlueprintLoopStore.updateStatus(Instance.scope.id, id, {
            status: "failed",
            error: err?.message ?? String(err),
          }).catch(() => undefined)
        }
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
        const loop = await BlueprintLoopStore.updateStatus(Instance.scope.id, id, { status: "waiting" })
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
        const loop = await BlueprintLoopStore.updateStatus(Instance.scope.id, id, { status: "running" })
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
        await BlueprintLoopStore.get(Instance.scope.id, c.req.valid("param").id)
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
        const session = await Session.update(id, (draft) => {
          draft.blueprint = { ...draft.blueprint, planMode }
        })
        return c.json(session)
      } catch (err: any) {
        if (err instanceof Storage.NotFoundError)
          return c.json({ message: `Session not found: ${c.req.valid("param").id}` }, 404)
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )
