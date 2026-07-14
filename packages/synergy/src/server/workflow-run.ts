import { Hono, type Context } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { errors } from "./error"
import { ScopeContext } from "../scope/context"
import { Storage } from "../storage/storage"
import {
  WorkflowRunStore,
  WorkflowRunService,
  CharterStore,
  WorkflowError,
  WorkflowTypes,
  WorkflowSeats,
} from "../workflow-run"

const WorkflowEventPage = z
  .object({
    items: WorkflowTypes.EventInfo.array(),
    nextCursor: z.string().optional(),
  })
  .meta({ ref: "WorkflowEventPage" })

const WorkflowConflictError = z
  .union([WorkflowError.CharterConflict.Schema, WorkflowError.TransitionRejected.Schema])
  .meta({ ref: "WorkflowConflictError" })

const workflowConflictResponse = {
  409: {
    description: "Workflow state conflict",
    content: { "application/json": { schema: resolver(WorkflowConflictError) } },
  },
} as const

const workflowForbiddenResponse = {
  403: {
    description: "Workflow operation is not authorized",
    content: { "application/json": { schema: resolver(WorkflowError.NotAuthorized.Schema) } },
  },
} as const

type ValidationResult =
  | { success: true; data: unknown; target: unknown }
  | { success: false; data: unknown; error: readonly unknown[]; target: unknown }

function validationHook(result: ValidationResult, c: Context) {
  if (result.success) return
  return c.json({ data: result.data, errors: result.error, success: false as const }, 400)
}

async function getWorkflowRun(scopeID: string, runID: string) {
  try {
    return await WorkflowRunStore.get(scopeID, runID)
  } catch (error) {
    if (error instanceof Storage.NotFoundError) {
      throw new Storage.NotFoundError({ message: `Workflow run not found: ${runID}` })
    }
    throw error
  }
}

function workflowErrorResponse(error: unknown, c: Context) {
  if (error instanceof WorkflowError.RunNotFound) {
    throw new Storage.NotFoundError({ message: `Workflow run not found: ${error.data.runID}` })
  }
  if (error instanceof WorkflowError.CharterNotFound) {
    const version = error.data.version === undefined ? "" : ` version ${error.data.version}`
    throw new Storage.NotFoundError({ message: `Workflow charter not found: ${error.data.charterID}${version}` })
  }
  if (error instanceof WorkflowError.CharterConflict || error instanceof WorkflowError.TransitionRejected) {
    return c.json(error.toObject(), 409)
  }
  if (error instanceof WorkflowError.NotAuthorized) return c.json(error.toObject(), 403)
  if (error instanceof WorkflowError.CharterInvalid) {
    return c.json(
      {
        data: error.data,
        errors: error.data.errors.map((message: string) => ({ message })),
        success: false as const,
      },
      400,
    )
  }
  throw error
}

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
      const runs = await WorkflowRunStore.list(ScopeContext.current.scope.id)
      return c.json(runs.map(WorkflowSeats.withProjectedStatus))
    },
  )
  .get(
    "/run/:id",
    describeRoute({
      summary: "Get a workflow run",
      operationId: "workflowRun.get",
      responses: {
        200: {
          description: "Workflow run",
          content: { "application/json": { schema: resolver(WorkflowTypes.Run) } },
        },
        ...errors(400, 404),
      },
    }),
    validator("param", z.object({ id: z.string() }), validationHook),
    async (c) => {
      const run = await getWorkflowRun(ScopeContext.current.scope.id, c.req.valid("param").id)
      return c.json(WorkflowSeats.withProjectedStatus(run))
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
          content: { "application/json": { schema: resolver(WorkflowEventPage) } },
        },
        ...errors(400, 404),
      },
    }),
    validator("param", z.object({ id: z.string() }), validationHook),
    validator(
      "query",
      z.object({
        after: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(100),
      }),
      validationHook,
    ),
    async (c) => {
      const scopeID = ScopeContext.current.scope.id
      const run = await getWorkflowRun(scopeID, c.req.valid("param").id)
      const query = c.req.valid("query")
      return c.json(await WorkflowRunStore.listEventsPage(scopeID, run.id, query))
    },
  )
  .post(
    "/run",
    describeRoute({
      summary: "Create a workflow run",
      operationId: "workflowRun.create",
      requestBody: { required: true, content: {} },
      responses: {
        200: { description: "Created run", content: { "application/json": { schema: resolver(WorkflowTypes.Run) } } },
        ...errors(400, 404),
        ...workflowConflictResponse,
        ...workflowForbiddenResponse,
      },
    }),
    validator(
      "json",
      z.object({
        charterID: z.string(),
        version: z.number().int().min(1).optional(),
        title: z.string(),
        bossSessionID: z.string(),
        maxModelCalls: z.number().int().min(0).optional(),
      }),
      validationHook,
    ),
    async (c) => {
      try {
        const body = c.req.valid("json")
        const run = await WorkflowRunService.create(body)
        return c.json(run)
      } catch (error) {
        return workflowErrorResponse(error, c)
      }
    },
  )
  .post(
    "/run/:id/control",
    describeRoute({
      summary: "Control a workflow run",
      operationId: "workflowRun.control",
      requestBody: { required: true, content: {} },
      responses: {
        200: { description: "Updated run", content: { "application/json": { schema: resolver(WorkflowTypes.Run) } } },
        ...errors(400, 404),
        ...workflowConflictResponse,
      },
    }),
    validator("param", z.object({ id: z.string() }), validationHook),
    validator("json", z.object({ action: z.enum(["pause", "resume", "cancel"]) }), validationHook),
    async (c) => {
      try {
        const run = await WorkflowRunService.control(c.req.valid("param").id, c.req.valid("json").action)
        return c.json(run)
      } catch (error) {
        return workflowErrorResponse(error, c)
      }
    },
  )
  .post(
    "/run/:id/entity",
    describeRoute({
      summary: "Add an entity to a workflow run",
      operationId: "workflowRun.entity.add",
      requestBody: { required: true, content: {} },
      responses: {
        200: {
          description: "Created entity",
          content: { "application/json": { schema: resolver(WorkflowTypes.Entity) } },
        },
        ...errors(400, 404),
        ...workflowConflictResponse,
      },
    }),
    validator("param", z.object({ id: z.string() }), validationHook),
    validator(
      "json",
      z.object({
        title: z.string(),
        description: z.string().optional(),
        affinityKey: z.string().optional(),
        bindings: z.record(z.string(), z.string()).optional(),
      }),
      validationHook,
    ),
    async (c) => {
      try {
        const entity = await WorkflowRunService.addEntity({ runID: c.req.valid("param").id, ...c.req.valid("json") })
        return c.json(entity)
      } catch (error) {
        return workflowErrorResponse(error, c)
      }
    },
  )
  .post(
    "/run/:id/gate/:gid",
    describeRoute({
      summary: "Resolve a gate (human decision)",
      operationId: "workflowRun.gate.resolve",
      requestBody: { required: true, content: {} },
      responses: {
        200: { description: "Updated run", content: { "application/json": { schema: resolver(WorkflowTypes.Run) } } },
        ...errors(400, 404),
        ...workflowConflictResponse,
      },
    }),
    validator("param", z.object({ id: z.string(), gid: z.string() }), validationHook),
    validator("json", z.object({ resolution: z.string() }), validationHook),
    async (c) => {
      try {
        const run = await WorkflowRunService.resolveGate({
          runID: c.req.valid("param").id,
          gateInstanceID: c.req.valid("param").gid,
          resolution: c.req.valid("json").resolution,
          resolvedBy: "human_ui",
        })
        return c.json(run)
      } catch (error) {
        return workflowErrorResponse(error, c)
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
      const charters = await CharterStore.list(ScopeContext.current.scope.id)
      return c.json(charters)
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
    validator("param", z.object({ id: z.string(), version: z.coerce.number().int().min(1) }), validationHook),
    async (c) => {
      try {
        const charter = await CharterStore.get(
          ScopeContext.current.scope.id,
          c.req.valid("param").id,
          c.req.valid("param").version,
        )
        return c.json(charter)
      } catch (error) {
        return workflowErrorResponse(error, c)
      }
    },
  )
