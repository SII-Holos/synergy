import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { errors } from "./error"
import { BlueprintLoopStore, LoopError } from "../blueprint"
import { Info as BlueprintLoopInfoSchema } from "../blueprint/types"
import { Instance } from "../scope/instance"
import { Storage } from "../storage/storage"
import { Session } from "../session"

const CreateInput = z
  .object({
    noteID: z.string().meta({ description: "Note ID to loop" }),
    noteVersion: z.number().optional().meta({ description: "Note version to lock" }),
    title: z.string().meta({ description: "Loop title" }),
    description: z.string().optional().meta({ description: "Loop description" }),
    sessionID: z.string().meta({ description: "Session ID driving this loop" }),
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
      description: "Create a new BlueprintLoop in the current scope.",
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
        const loop = await BlueprintLoopStore.create(body)
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
