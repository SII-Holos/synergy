import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import { errors } from "./error"
import { ScopeContext } from "../scope/context"
import { LatticeStore } from "../lattice/store"
import { LatticeRunService } from "../lattice/run-service"
import { LatticeError } from "../lattice"
import { LatticeTypes } from "../lattice/types"
import { SessionWorkflowService } from "../session/workflow"
import z from "zod"

const RunOrNull = LatticeTypes.Run.nullable()

export const LatticeRoute = new Hono()
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
        await SessionWorkflowService.clearIfLattice(run.sessionID)
        return c.json(run)
      } catch (err: any) {
        if (err instanceof LatticeError.NotFound)
          return c.json({ message: `Lattice run not found: ${c.req.valid("param").id}` }, 404)
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )
