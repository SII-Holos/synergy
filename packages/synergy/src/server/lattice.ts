import { Hono, type Context } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { LatticeError } from "../lattice/error"
import { LatticeRunService } from "../lattice/run-service"
import { LatticeStore } from "../lattice/store"
import { LatticeTypes } from "../lattice/types"
import { ScopeContext } from "../scope/context"
import { errors } from "./error"

const RunOrNull = LatticeTypes.RunView.nullable()
const RunID = z.object({ id: z.string().min(1).meta({ description: "Lattice Run ID" }) }).strict()
const SessionID = z.object({ id: z.string().min(1).meta({ description: "Session ID" }) }).strict()
const EmptyMutationBody = z.object({}).strict().optional()
const InternalServerError = z.object({ message: z.string() }).strict().meta({ ref: "LatticeInternalServerError" })

function routeErrors(...codes: Array<400 | 404 | 409>) {
  return {
    ...errors(...codes),
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: resolver(InternalServerError) } },
    },
  }
}

function handleError(c: Context, error: unknown, runID?: string): Response {
  if (error instanceof LatticeError.NotFound) {
    return c.json({ message: error.message, data: error.data ?? { runID } }, 404)
  }
  if (error instanceof LatticeError.StateConflict || error instanceof LatticeError.InvalidPathway) {
    return c.json({ message: error.message, data: error.data }, 409)
  }
  return c.json({ message: "Internal server error" }, 500)
}

function runView(run: LatticeTypes.Run): LatticeTypes.RunView {
  return LatticeTypes.toRunView(run)
}

export const LatticeRoute = new Hono()
  .get(
    "/session/:id",
    describeRoute({
      summary: "Get the current Lattice Run for a Session",
      description: "Returns the current Run pointer projection, or null when the Session has no Lattice history.",
      operationId: "lattice.session.getRun",
      responses: {
        200: {
          description: "Current Lattice Run or null",
          content: { "application/json": { schema: resolver(RunOrNull) } },
        },
        ...routeErrors(400),
      },
    }),
    validator("param", SessionID),
    async (c) => {
      try {
        const sessionID = c.req.valid("param").id
        const run = await LatticeStore.getOrUndefined(ScopeContext.current.scope.id, sessionID)
        return c.json(run ? runView(run) : null)
      } catch (error) {
        return handleError(c, error)
      }
    },
  )
  .get(
    "/run",
    describeRoute({
      summary: "List Lattice Runs",
      description: "Lists current and terminal Run history for the current Scope.",
      operationId: "lattice.run.list",
      responses: {
        200: {
          description: "Lattice Run history",
          content: { "application/json": { schema: resolver(LatticeTypes.RunView.array()) } },
        },
        ...routeErrors(400),
      },
    }),
    async (c) => {
      try {
        const runs = await LatticeStore.list(ScopeContext.current.scope.id)
        return c.json(runs.map(runView))
      } catch (error) {
        return handleError(c, error)
      }
    },
  )
  .get(
    "/run/:id",
    describeRoute({
      summary: "Get a Lattice Run",
      operationId: "lattice.run.get",
      responses: {
        200: {
          description: "Lattice Run",
          content: { "application/json": { schema: resolver(LatticeTypes.RunView) } },
        },
        ...routeErrors(400, 404),
      },
    }),
    validator("param", RunID),
    async (c) => {
      const runID = c.req.valid("param").id
      try {
        const run = await LatticeStore.getByRunID(ScopeContext.current.scope.id, runID)
        if (!run) throw new LatticeError.NotFound({ runID })
        return c.json(runView(run))
      } catch (error) {
        return handleError(c, error, runID)
      }
    },
  )
  .get(
    "/run/:id/events",
    describeRoute({
      summary: "List Lattice Run events",
      description: "Returns best-effort audit events for one Run in the current Scope.",
      operationId: "lattice.run.events",
      responses: {
        200: {
          description: "Lattice audit events",
          content: { "application/json": { schema: resolver(LatticeTypes.EventInfo.array()) } },
        },
        ...routeErrors(400, 404),
      },
    }),
    validator("param", RunID),
    async (c) => {
      const runID = c.req.valid("param").id
      try {
        const scopeID = ScopeContext.current.scope.id
        const run = await LatticeStore.getByRunID(scopeID, runID)
        if (!run) throw new LatticeError.NotFound({ runID })
        return c.json(await LatticeStore.listEvents(scopeID, run.id))
      } catch (error) {
        return handleError(c, error, runID)
      }
    },
  )
  .post(
    "/run/:id/pause",
    describeRoute({
      summary: "Pause a Lattice Run",
      operationId: "lattice.run.pause",
      responses: {
        200: {
          description: "Paused Lattice Run",
          content: { "application/json": { schema: resolver(LatticeTypes.RunView) } },
        },
        ...routeErrors(400, 404, 409),
      },
    }),
    validator("param", RunID),
    validator("json", EmptyMutationBody),
    async (c) => {
      const runID = c.req.valid("param").id
      try {
        return c.json(runView(await LatticeRunService.pause(runID)))
      } catch (error) {
        return handleError(c, error, runID)
      }
    },
  )
  .post(
    "/run/:id/resume",
    describeRoute({
      summary: "Resume a paused Lattice Run",
      operationId: "lattice.run.resume",
      responses: {
        200: {
          description: "Resumed Lattice Run",
          content: { "application/json": { schema: resolver(LatticeTypes.RunView) } },
        },
        ...routeErrors(400, 404, 409),
      },
    }),
    validator("param", RunID),
    validator("json", EmptyMutationBody),
    async (c) => {
      const runID = c.req.valid("param").id
      try {
        return c.json(runView(await LatticeRunService.resume(runID)))
      } catch (error) {
        return handleError(c, error, runID)
      }
    },
  )
  .post(
    "/run/:id/cancel",
    describeRoute({
      summary: "Cancel a Lattice Run",
      description: "Irreversibly cancels the Run while retaining its durable history.",
      operationId: "lattice.run.cancel",
      responses: {
        200: {
          description: "Cancelled Lattice Run",
          content: { "application/json": { schema: resolver(LatticeTypes.RunView) } },
        },
        ...routeErrors(400, 404, 409),
      },
    }),
    validator("param", RunID),
    validator("json", EmptyMutationBody),
    async (c) => {
      const runID = c.req.valid("param").id
      try {
        return c.json(runView(await LatticeRunService.cancel(runID)))
      } catch (error) {
        return handleError(c, error, runID)
      }
    },
  )
  .post(
    "/run/:id/approve",
    describeRoute({
      summary: "Approve collaborative Blueprint execution",
      description: "The Panel approval is the complete user intent; attached execution instructions are rejected.",
      operationId: "lattice.run.approve",
      responses: {
        200: {
          description: "Updated Lattice Run",
          content: { "application/json": { schema: resolver(LatticeTypes.RunView) } },
        },
        ...routeErrors(400, 404, 409),
      },
    }),
    validator("param", RunID),
    validator("json", EmptyMutationBody),
    async (c) => {
      const runID = c.req.valid("param").id
      try {
        return c.json(runView(await LatticeRunService.approve(runID)))
      } catch (error) {
        return handleError(c, error, runID)
      }
    },
  )
