import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { errors } from "./error"
import { ScopeContext } from "../scope/context"
import { Storage } from "../storage/storage"
import { LatticeStore } from "../lattice/store"
import { LatticeRunService } from "../lattice/run-service"
import { LatticeError } from "../lattice"
import { LatticeTypes } from "../lattice/types"

const ModeInput = z
  .object({
    enabled: z.boolean().meta({ description: "Enable or disable Lattice mode for the session" }),
    mode: z.enum(["auto", "collaborative"]).optional().meta({ description: "Lattice mode (default auto)" }),
    max_model_calls: z
      .number()
      .int()
      .min(0)
      .optional()
      .meta({ description: "Model-call budget (0 = unlimited). Not Pathway steps." }),
    goal: z.string().optional().meta({ description: "High-level goal for the run" }),
    action: z.enum(["continue", "restart"]).optional().meta({ description: "Resume a paused run or restart it" }),
  })
  .meta({ ref: "LatticeModeInput" })

const RunOrNull = LatticeTypes.Run.nullable()

export const LatticeRoute = new Hono()
  .put(
    "/session/:id/mode",
    describeRoute({
      summary: "Toggle Lattice mode",
      description: "Enable (create/continue/restart) or disable (pause) Lattice mode on a session.",
      operationId: "lattice.session.mode",
      responses: {
        200: { description: "Lattice run or null", content: { "application/json": { schema: resolver(RunOrNull) } } },
        ...errors(400, 404),
      },
    }),
    validator("param", z.object({ id: z.string().meta({ description: "Session ID" }) })),
    validator("json", ModeInput),
    async (c) => {
      try {
        const sessionID = c.req.valid("param").id
        const body = c.req.valid("json")
        if (body.enabled) {
          const run = await LatticeRunService.enable({
            sessionID,
            mode: body.mode ?? "auto",
            maxModelCalls: body.max_model_calls,
            goal: body.goal,
            action: body.action,
          })
          return c.json(run)
        }
        const run = await LatticeRunService.disable(sessionID)
        return c.json(run ?? null)
      } catch (err: any) {
        if (err instanceof Storage.NotFoundError)
          return c.json({ message: `Session not found: ${c.req.valid("param").id}` }, 404)
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )
  .get(
    "/session/:id",
    describeRoute({
      summary: "Get session Lattice run",
      description: "Read the session's single Lattice run (or null).",
      operationId: "lattice.session.getRun",
      responses: {
        200: { description: "Lattice run or null", content: { "application/json": { schema: resolver(RunOrNull) } } },
        ...errors(400),
      },
    }),
    validator("param", z.object({ id: z.string().meta({ description: "Session ID" }) })),
    async (c) => {
      try {
        const sessionID = c.req.valid("param").id
        const run = await LatticeStore.getOrUndefined(ScopeContext.current.scope.id, sessionID)
        return c.json(run ?? null)
      } catch (err: any) {
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )
  .get(
    "/run",
    describeRoute({
      summary: "List Lattice runs",
      description: "List all Lattice runs for the current scope (at most one per session).",
      operationId: "lattice.run.list",
      responses: {
        200: {
          description: "Lattice runs",
          content: { "application/json": { schema: resolver(LatticeTypes.Run.array()) } },
        },
        ...errors(400),
      },
    }),
    async (c) => {
      try {
        const runs = await LatticeStore.list(ScopeContext.current.scope.id)
        return c.json(runs)
      } catch (err: any) {
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )
  .get(
    "/run/:id",
    describeRoute({
      summary: "Get Lattice run",
      operationId: "lattice.run.get",
      responses: {
        200: { description: "Lattice run", content: { "application/json": { schema: resolver(LatticeTypes.Run) } } },
        ...errors(400, 404),
      },
    }),
    validator("param", z.object({ id: z.string().meta({ description: "Lattice run ID" }) })),
    async (c) => {
      try {
        const run = await LatticeStore.getByRunID(ScopeContext.current.scope.id, c.req.valid("param").id)
        if (!run) return c.json({ message: `Lattice run not found: ${c.req.valid("param").id}` }, 404)
        return c.json(run)
      } catch (err: any) {
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )
  .get(
    "/run/:id/events",
    describeRoute({
      summary: "List Lattice run events",
      operationId: "lattice.run.events",
      responses: {
        200: {
          description: "Lattice events",
          content: { "application/json": { schema: resolver(LatticeTypes.EventInfo.array()) } },
        },
        ...errors(400, 404),
      },
    }),
    validator("param", z.object({ id: z.string().meta({ description: "Lattice run ID" }) })),
    async (c) => {
      try {
        const scopeID = ScopeContext.current.scope.id
        const run = await LatticeStore.getByRunID(scopeID, c.req.valid("param").id)
        if (!run) return c.json({ message: `Lattice run not found: ${c.req.valid("param").id}` }, 404)
        const events = await LatticeStore.listEvents(scopeID, run.sessionID)
        return c.json(events)
      } catch (err: any) {
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )
  .post(
    "/run/:id/continue",
    describeRoute({
      summary: "Continue a collaborative Blueprint review",
      description: "Start the current step's BlueprintLoop (collaborative blueprint_review only).",
      operationId: "lattice.run.continue",
      responses: {
        200: { description: "Updated run", content: { "application/json": { schema: resolver(LatticeTypes.Run) } } },
        ...errors(400, 404),
      },
    }),
    validator("param", z.object({ id: z.string().meta({ description: "Lattice run ID" }) })),
    validator(
      "json",
      z
        .object({
          userPrompt: z.string().optional().meta({ description: "Optional instruction merged into the loop start" }),
        })
        .optional(),
    ),
    async (c) => {
      try {
        const body = c.req.valid("json")
        const run = await LatticeRunService.continueReview(c.req.valid("param").id, body?.userPrompt)
        return c.json(run)
      } catch (err: any) {
        if (err instanceof LatticeError.NotFound)
          return c.json({ message: `Lattice run not found: ${c.req.valid("param").id}` }, 404)
        if (err instanceof LatticeError.PhaseViolation) return c.json({ message: err.message, data: err.data }, 400)
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )
  .post(
    "/run/:id/cancel",
    describeRoute({
      summary: "Cancel a Lattice run",
      operationId: "lattice.run.cancel",
      responses: {
        200: { description: "Cancelled run", content: { "application/json": { schema: resolver(LatticeTypes.Run) } } },
        ...errors(400, 404),
      },
    }),
    validator("param", z.object({ id: z.string().meta({ description: "Lattice run ID" }) })),
    async (c) => {
      try {
        const run = await LatticeRunService.cancel(c.req.valid("param").id)
        return c.json(run)
      } catch (err: any) {
        if (err instanceof LatticeError.NotFound)
          return c.json({ message: `Lattice run not found: ${c.req.valid("param").id}` }, 404)
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )
