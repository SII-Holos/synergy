import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { errors } from "./error"
import { ScopeContext } from "../scope/context"
import { WorkflowRunStore, WorkflowRunService, CharterStore, WorkflowError, WorkflowTypes } from "../workflow-run"

const RunOrNull = WorkflowTypes.Run.nullable()

export const WorkflowRunRoute = new Hono()
  .get(
    "/run",
    describeRoute({
      summary: "List workflow runs",
      operationId: "workflowRun.list",
      responses: {
        200: {
          description: "Workflow runs",
          content: { "application/json": { schema: resolver(WorkflowTypes.Run.array()) } },
        },
        ...errors(400),
      },
    }),
    async (c) => {
      try {
        const runs = await WorkflowRunStore.list(ScopeContext.current.scope.id)
        return c.json(runs)
      } catch (err: any) {
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )
  .get(
    "/run/:id",
    describeRoute({
      summary: "Get a workflow run",
      operationId: "workflowRun.get",
      responses: {
        200: { description: "Workflow run", content: { "application/json": { schema: resolver(RunOrNull) } } },
        ...errors(400),
      },
    }),
    validator("param", z.object({ id: z.string() })),
    async (c) => {
      try {
        const run = await WorkflowRunStore.getOrUndefined(ScopeContext.current.scope.id, c.req.valid("param").id)
        return c.json(run ?? null)
      } catch (err: any) {
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )
  .get(
    "/run/:id/events",
    describeRoute({
      summary: "List workflow run events",
      operationId: "workflowRun.events",
      responses: {
        200: {
          description: "Workflow events",
          content: { "application/json": { schema: resolver(WorkflowTypes.EventInfo.array()) } },
        },
        ...errors(400, 404),
      },
    }),
    validator("param", z.object({ id: z.string() })),
    validator("query", z.object({ after: z.string().optional() })),
    async (c) => {
      try {
        const scopeID = ScopeContext.current.scope.id
        const run = await WorkflowRunStore.getOrUndefined(scopeID, c.req.valid("param").id)
        if (!run) return c.json({ message: `Workflow run not found: ${c.req.valid("param").id}` }, 404)
        const events = await WorkflowRunStore.listEvents(scopeID, run.id)
        const after = c.req.valid("query").after
        const filtered = after ? events.filter((e) => e.id > after) : events
        return c.json(filtered)
      } catch (err: any) {
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )
  .post(
    "/run",
    describeRoute({
      summary: "Create a workflow run",
      operationId: "workflowRun.create",
      responses: {
        200: { description: "Created run", content: { "application/json": { schema: resolver(WorkflowTypes.Run) } } },
        ...errors(400),
      },
    }),
    validator(
      "json",
      z.object({
        charterID: z.string(),
        version: z.number().optional(),
        title: z.string(),
        bossSessionID: z.string(),
        maxModelCalls: z.number().optional(),
      }),
    ),
    async (c) => {
      try {
        const body = c.req.valid("json")
        const run = await WorkflowRunService.create(body)
        return c.json(run)
      } catch (err: any) {
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )
  .post(
    "/run/:id/control",
    describeRoute({
      summary: "Control a workflow run",
      operationId: "workflowRun.control",
      responses: {
        200: { description: "Updated run", content: { "application/json": { schema: resolver(WorkflowTypes.Run) } } },
        ...errors(400, 404),
      },
    }),
    validator("param", z.object({ id: z.string() })),
    validator("json", z.object({ action: z.enum(["pause", "resume", "cancel"]) })),
    async (c) => {
      try {
        const run = await WorkflowRunService.control(c.req.valid("param").id, c.req.valid("json").action)
        return c.json(run)
      } catch (err: any) {
        if (err instanceof WorkflowError.RunNotFound) return c.json({ message: err.message }, 404)
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )
  .post(
    "/run/:id/entity",
    describeRoute({
      summary: "Add an entity to a workflow run",
      operationId: "workflowRun.entity.add",
      responses: {
        200: {
          description: "Created entity",
          content: { "application/json": { schema: resolver(WorkflowTypes.Entity) } },
        },
        ...errors(400),
      },
    }),
    validator("param", z.object({ id: z.string() })),
    validator(
      "json",
      z.object({
        title: z.string(),
        description: z.string().optional(),
        affinityKey: z.string().optional(),
        bindings: z.record(z.string(), z.string()).optional(),
      }),
    ),
    async (c) => {
      try {
        const entity = await WorkflowRunService.addEntity({ runID: c.req.valid("param").id, ...c.req.valid("json") })
        return c.json(entity)
      } catch (err: any) {
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )
  .post(
    "/run/:id/gate/:gid",
    describeRoute({
      summary: "Resolve a gate (human decision)",
      operationId: "workflowRun.gate.resolve",
      responses: {
        200: { description: "Updated run", content: { "application/json": { schema: resolver(WorkflowTypes.Run) } } },
        ...errors(400),
      },
    }),
    validator("param", z.object({ id: z.string(), gid: z.string() })),
    validator("json", z.object({ resolution: z.string() })),
    async (c) => {
      try {
        const run = await WorkflowRunService.resolveGate({
          runID: c.req.valid("param").id,
          gateInstanceID: c.req.valid("param").gid,
          resolution: c.req.valid("json").resolution,
          resolvedBy: "human_ui",
        })
        return c.json(run)
      } catch (err: any) {
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )
  .get(
    "/charter",
    describeRoute({
      summary: "List charters",
      operationId: "workflowCharter.list",
      responses: {
        200: {
          description: "Charters",
          content: { "application/json": { schema: resolver(WorkflowTypes.Charter.array()) } },
        },
        ...errors(400),
      },
    }),
    async (c) => {
      try {
        const charters = await CharterStore.list(ScopeContext.current.scope.id)
        return c.json(charters)
      } catch (err: any) {
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )
  .get(
    "/charter/:id/:version",
    describeRoute({
      summary: "Get a charter version",
      operationId: "workflowCharter.get",
      responses: {
        200: { description: "Charter", content: { "application/json": { schema: resolver(WorkflowTypes.Charter) } } },
        ...errors(400, 404),
      },
    }),
    validator("param", z.object({ id: z.string(), version: z.coerce.number() })),
    async (c) => {
      try {
        const charter = await CharterStore.getOrUndefined(
          ScopeContext.current.scope.id,
          c.req.valid("param").id,
          c.req.valid("param").version,
        )
        if (!charter) return c.json({ message: "Charter not found" }, 404)
        return c.json(charter)
      } catch (err: any) {
        return c.json({ message: err?.message ?? String(err) }, 400)
      }
    },
  )
