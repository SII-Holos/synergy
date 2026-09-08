import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { z } from "zod"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { errors } from "@ericsanchezok/synergy-server/server/error"
import { AgendaStore } from "../store"
import { AgendaTypes } from "../types"

export const SessionAgendaRoute = new Hono().get(
  "/:sessionID/agenda",
  describeRoute({
    summary: "Get session agenda wakeups",
    description: "Retrieve agenda items that can wake the specified session.",
    operationId: "session.agenda",
    responses: {
      200: {
        description: "Session agenda wakeups",
        content: {
          "application/json": {
            schema: resolver(AgendaTypes.SessionAgendaResponse),
          },
        },
      },
      ...errors(400, 404),
    },
  }),
  validator(
    "param",
    z.object({
      sessionID: z.string().meta({ description: "Session ID" }),
    }),
  ),
  validator(
    "query",
    z.object({
      limit: z.coerce.number().int().min(0).max(50).default(6),
      offset: z.coerce.number().int().min(0).default(0),
    }),
  ),
  async (c) => {
    const { sessionID } = c.req.valid("param")
    const { limit, offset } = c.req.valid("query")
    const session = await Session.get(sessionID)
    const result = await AgendaStore.listForSessionWakeups({
      sessionID,
      scopeID: session.scope.id,
      limit,
      offset,
    })
    return c.json(result)
  },
)
