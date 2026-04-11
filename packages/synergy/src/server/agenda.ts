import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { errors } from "./error"
import { Agenda, AgendaStore, AgendaTypes } from "../agenda"
import { Storage } from "../storage/storage"

export const AgendaRoute = new Hono()

  .get(
    "/:id/sessions",
    describeRoute({
      summary: "List sessions for agenda item",
      description: "List all sessions triggered by a specific agenda item.",
      operationId: "agenda.sessions",
      responses: {
        200: {
          description: "List of session references",
          content: {
            "application/json": {
              schema: resolver(
                z
                  .object({
                    sessionID: z.string(),
                    scopeID: z.string(),
                  })
                  .array()
                  .meta({ ref: "AgendaSessionList" }),
              ),
            },
          },
        },
        ...errors(400),
      },
    }),
    validator("param", z.object({ id: z.string().meta({ description: "Agenda item ID" }) })),
    async (c) => {
      try {
        const id = c.req.valid("param").id
        const sessions = await AgendaStore.listSessions(id)
        return c.json(sessions)
      } catch (err: any) {
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )

  .get(
    "/:id/runs",
    describeRoute({
      summary: "List runs for agenda item",
      description: "List the execution history for a specific agenda item.",
      operationId: "agenda.runs",
      responses: {
        200: {
          description: "List of run logs",
          content: { "application/json": { schema: resolver(AgendaTypes.RunLog.array()) } },
        },
        ...errors(400),
      },
    }),
    validator("param", z.object({ id: z.string().meta({ description: "Agenda item ID" }) })),
    async (c) => {
      try {
        const id = c.req.valid("param").id
        const { scopeID } = await AgendaStore.find(id)
        const runs = await AgendaStore.listRuns(scopeID, id)
        return c.json(runs)
      } catch (err: any) {
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )

  .post(
    "/:id/trigger",
    describeRoute({
      summary: "Trigger agenda item",
      description: "Manually trigger an agenda item for immediate execution.",
      operationId: "agenda.trigger",
      responses: {
        200: {
          description: "Trigger accepted",
          content: {
            "application/json": {
              schema: resolver(
                z
                  .object({
                    triggered: z.literal(true),
                    sessionID: z.string().optional().describe("Session ID of the execution"),
                  })
                  .meta({ ref: "AgendaTriggerResult" }),
              ),
            },
          },
        },
        ...errors(400),
      },
    }),
    validator("param", z.object({ id: z.string().meta({ description: "Agenda item ID" }) })),
    async (c) => {
      try {
        const id = c.req.valid("param").id
        const result = await Agenda.trigger(id)
        return c.json({ triggered: true as const, sessionID: result.sessionID })
      } catch (err: any) {
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )

  .post(
    "/:id/activate",
    describeRoute({
      summary: "Activate agenda item",
      description: "Resume or activate a paused or pending agenda item.",
      operationId: "agenda.activate",
      responses: {
        200: {
          description: "Updated item",
          content: { "application/json": { schema: resolver(AgendaTypes.Item) } },
        },
        ...errors(400),
      },
    }),
    validator("param", z.object({ id: z.string().meta({ description: "Agenda item ID" }) })),
    async (c) => {
      try {
        const id = c.req.valid("param").id
        const item = await Agenda.activate(id)
        return c.json(item)
      } catch (err: any) {
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )

  .post(
    "/:id/pause",
    describeRoute({
      summary: "Pause agenda item",
      description: "Pause an active agenda item, suspending its triggers.",
      operationId: "agenda.pause",
      responses: {
        200: {
          description: "Updated item",
          content: { "application/json": { schema: resolver(AgendaTypes.Item) } },
        },
        ...errors(400),
      },
    }),
    validator("param", z.object({ id: z.string().meta({ description: "Agenda item ID" }) })),
    async (c) => {
      try {
        const id = c.req.valid("param").id
        const item = await Agenda.pause(id)
        return c.json(item)
      } catch (err: any) {
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )

  .post(
    "/:id/complete",
    describeRoute({
      summary: "Complete agenda item",
      description: "Mark an agenda item as done.",
      operationId: "agenda.complete",
      responses: {
        200: {
          description: "Updated item",
          content: { "application/json": { schema: resolver(AgendaTypes.Item) } },
        },
        ...errors(400),
      },
    }),
    validator("param", z.object({ id: z.string().meta({ description: "Agenda item ID" }) })),
    async (c) => {
      try {
        const id = c.req.valid("param").id
        const item = await Agenda.complete(id)
        return c.json(item)
      } catch (err: any) {
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )

  .post(
    "/:id/cancel",
    describeRoute({
      summary: "Cancel agenda item",
      description: "Cancel an agenda item, stopping all triggers and future executions.",
      operationId: "agenda.cancel",
      responses: {
        200: {
          description: "Updated item",
          content: { "application/json": { schema: resolver(AgendaTypes.Item) } },
        },
        ...errors(400),
      },
    }),
    validator("param", z.object({ id: z.string().meta({ description: "Agenda item ID" }) })),
    async (c) => {
      try {
        const id = c.req.valid("param").id
        const item = await Agenda.cancel(id)
        return c.json(item)
      } catch (err: any) {
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )

  .get(
    "/:id",
    describeRoute({
      summary: "Get agenda item",
      description: "Get a specific agenda item by ID.",
      operationId: "agenda.get",
      responses: {
        200: {
          description: "Agenda item",
          content: { "application/json": { schema: resolver(AgendaTypes.Item) } },
        },
        ...errors(400, 404),
      },
    }),
    validator("param", z.object({ id: z.string().meta({ description: "Agenda item ID" }) })),
    async (c) => {
      try {
        const id = c.req.valid("param").id
        const { item } = await AgendaStore.find(id)
        return c.json(item)
      } catch (err: any) {
        return c.json({ message: `Agenda item not found: ${c.req.valid("param").id}` }, 404)
      }
    },
  )

  .delete(
    "/:id",
    describeRoute({
      summary: "Delete agenda item",
      description: "Delete an agenda item and all its run history permanently.",
      operationId: "agenda.remove",
      responses: {
        200: {
          description: "Deleted",
          content: { "application/json": { schema: resolver(z.boolean()) } },
        },
        ...errors(400),
      },
    }),
    validator("param", z.object({ id: z.string().meta({ description: "Agenda item ID" }) })),
    async (c) => {
      try {
        const id = c.req.valid("param").id
        await Agenda.remove(id)
        return c.json(true)
      } catch (err: any) {
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )

  .post(
    "/",
    describeRoute({
      summary: "Create agenda item",
      description: "Create a new agenda item with optional triggers, task, and delivery configuration.",
      operationId: "agenda.create",
      responses: {
        200: {
          description: "Created item",
          content: { "application/json": { schema: resolver(AgendaTypes.Item) } },
        },
        ...errors(400),
      },
    }),
    validator("json", AgendaTypes.CreateInput),
    async (c) => {
      try {
        const input = c.req.valid("json")
        const item = await Agenda.create(input)
        return c.json(item)
      } catch (err: any) {
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )

  .patch(
    "/:id",
    describeRoute({
      summary: "Update agenda item",
      description: "Update fields of an existing agenda item.",
      operationId: "agenda.update",
      responses: {
        200: {
          description: "Updated item",
          content: { "application/json": { schema: resolver(AgendaTypes.Item) } },
        },
        ...errors(400, 404),
      },
    }),
    validator("param", z.object({ id: z.string().meta({ description: "Agenda item ID" }) })),
    validator("json", AgendaTypes.PatchInput),
    async (c) => {
      try {
        const id = c.req.valid("param").id
        const patch = c.req.valid("json")
        const item = await Agenda.update(id, patch)
        return c.json(item)
      } catch (err: any) {
        if (err instanceof Storage.NotFoundError)
          return c.json({ message: `Agenda item not found: ${c.req.valid("param").id}` }, 404)
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )

  .get(
    "/",
    describeRoute({
      summary: "List agenda items",
      description: "List all agenda items.",
      operationId: "agenda.list",
      responses: {
        200: {
          description: "List of agenda items",
          content: { "application/json": { schema: resolver(AgendaTypes.Item.array()) } },
        },
        ...errors(400),
      },
    }),
    async (c) => {
      try {
        const items = await AgendaStore.listAll()
        return c.json(items)
      } catch (err: any) {
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )
