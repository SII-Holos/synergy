import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
// errors import removed — using clarusError* refs instead
import { Bus } from "../bus"
import { NavigationUpdated } from "../clarus/event"
import { ClarusBindingStore, ClarusTaskBindingStore, ClarusProjectActivityStore, ClarusRuntime } from "../clarus"
import {
  toNavigationProjectDto,
  toNavigationTaskDto,
  toNavigationConnectionStatus,
  sortTasksByPriority,
} from "../clarus/navigation"
import type { ClarusProjectBindingV3, ClarusTaskBindingV4 } from "../clarus/schemas"
import { ClarusProjectBindingV3Schema, ClarusTaskBindingV4Schema } from "../clarus/schemas"
import { MAX_SEGMENT_LENGTH, validateSegment } from "../clarus/keys"
import {
  MAX_WIRE_STRING_ID,
  MAX_WIRE_STRING_TITLE,
  MAX_WIRE_STRING_STATUS,
  MAX_WIRE_STRING_ROLE,
  MAX_WIRE_STRING_CURSOR,
  MAX_WIRE_PAGE_SIZE,
  MAX_WIRE_STRING_ERROR_MESSAGE,
  MAX_USER_CANDIDATES,
  MAX_WIRE_METADATA_KEYS,
  MAX_WIRE_METADATA_KEY_LENGTH,
  MAX_WIRE_METADATA_RECURSION_DEPTH,
} from "../clarus/rest-port"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"

// ── Shared schema names (API-visible refs) ──────────────────

const ClarusConnectionStatusSchema = z.enum([
  "disabled",
  "disconnected",
  "connecting",
  "connected",
  "reconnecting",
  "blocked",
])

const ClarusStatusResponse = z
  .object({
    agentId: z.string().nullable(),
    status: ClarusConnectionStatusSchema,
    epoch: z.number(),
    generation: z.number(),
    isReconciling: z.boolean(),
    error: z.string().optional(),
  })
  .meta({ ref: "ClarusStatusResponse" })

const ClarusReconnectResponse = z
  .object({
    agentId: z.string().nullable(),
    status: ClarusConnectionStatusSchema,
    epoch: z.number(),
    generation: z.number(),
    isReconciling: z.boolean(),
    error: z.string().optional(),
  })
  .meta({ ref: "ClarusReconnectResponse" })

const ClarusProjectBindingItem = z
  .object({
    agentId: z.string(),
    projectId: z.string(),
    lifecycle: z.string(),
    projectName: z.string().optional(),
    projectSlug: z.string().optional(),
    projectStatus: z.string().optional(),
    primaryAgent: z.string().nullable().optional(),
    desiredSubscription: z.boolean(),
    messageCursor: z.string().nullable().optional(),
    lastProjectActivityAt: z.number().optional(),
    lastReconciliationAt: z.number().optional(),
    lastReconciliationError: z.string().nullable().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .meta({ ref: "ClarusProjectBindingItem" })

const ClarusProjectBindingCreateInput = z
  .object({
    projectId: z.string().min(1).max(MAX_SEGMENT_LENGTH),
    projectName: z.string().max(MAX_WIRE_STRING_TITLE),
    projectSlug: z.string().max(MAX_WIRE_STRING_TITLE).optional(),
    projectStatus: z.string().max(MAX_WIRE_STRING_STATUS).optional(),
    primaryAgent: z.string().max(MAX_WIRE_STRING_ID).nullable().optional(),
  })
  .meta({ ref: "ClarusProjectBindingCreateInput" })

const ClarusProjectBindingUpdateInput = z
  .object({
    projectName: z.string().max(MAX_WIRE_STRING_TITLE).optional(),
    projectSlug: z.string().max(MAX_WIRE_STRING_TITLE).optional(),
    projectStatus: z.string().max(MAX_WIRE_STRING_STATUS).optional(),
    primaryAgent: z.string().max(MAX_WIRE_STRING_ID).nullable().optional(),
  })
  .meta({ ref: "ClarusProjectBindingUpdateInput" })

const ClarusProjectBindingListResponse = z
  .object({
    items: ClarusProjectBindingItem.array(),
    nextCursor: z.string().max(MAX_WIRE_STRING_CURSOR).nullable(),
  })
  .meta({ ref: "ClarusProjectBindingListResponse" })

// Bounded metadata type for API-visible schemas (avoids z.unknown())
// Uses z.unknown() for nested values to avoid unresolvable z.lazy() self-references in OpenAPI generation.
const ClarusWireMetadataValue: z.ZodTypeAny = z
  .union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.unknown()), z.record(z.string(), z.unknown())])
  .meta({ ref: "ClarusWireMetadataValue" })

const ClarusBoundedFileRefsSchema = z.array(ClarusWireMetadataValue).max(50)
const ClarusBoundedMetadataSchema = z
  .record(z.string().max(MAX_WIRE_METADATA_KEY_LENGTH), ClarusWireMetadataValue)
  .refine((obj) => Object.keys(obj).length <= MAX_WIRE_METADATA_KEYS, {
    message: "metadata key count exceeds limit",
  })

const ClarusProjectActivityItem = z
  .object({
    agentId: z.string(),
    projectId: z.string(),
    messageId: z.string(),
    senderType: z.string().optional(),
    senderId: z.string().optional(),
    messageType: z.string().optional(),
    content: z.string().optional(),
    fileRefs: ClarusBoundedFileRefsSchema.optional(),
    metadata: ClarusBoundedMetadataSchema.optional(),
    createdAt: z.string().optional(),
    receivedAt: z.number(),
  })
  .meta({ ref: "ClarusProjectActivityItem" })

const ClarusProjectActivityResponse = z
  .object({
    items: ClarusProjectActivityItem.array(),
    nextCursor: z.string().max(MAX_WIRE_STRING_CURSOR).nullable(),
  })
  .meta({ ref: "ClarusProjectActivityResponse" })

const ClarusTaskBindingItem = z
  .object({
    agentId: z.string(),
    projectId: z.string(),
    taskId: z.string(),
    sessionID: z.string(),
    runID: z.string(),
    subtaskID: z.string(),
    phase: z.string(),
    attempt: z.number(),
    deadlineAt: z.string().nullable().optional(),
    title: z.string(),
    status: z.string(),
    resultState: z.string(),
    contextHydration: z.string(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .meta({ ref: "ClarusTaskBindingItem" })

const ClarusTaskBindingListResponse = z
  .object({
    items: ClarusTaskBindingItem.array(),
    nextCursor: z.string().max(MAX_WIRE_STRING_CURSOR).nullable(),
    total: z.number(),
  })
  .meta({ ref: "ClarusTaskBindingListResponse" })

const ClarusComposerUserItem = z
  .object({
    userId: z.string(),
    userName: z.string(),
    agentId: z.string(),
  })
  .meta({ ref: "ClarusComposerUserItem" })

const ClarusComposerProjectItem = z
  .object({
    projectId: z.string(),
    projectName: z.string(),
  })
  .meta({ ref: "ClarusComposerProjectItem" })

// Bounded fileRefs schema for composer submit (narrow record shape, no z.unknown values)
const ClarusComposerFileRefsSchema = z.array(z.record(z.string(), ClarusWireMetadataValue)).max(50)

const ClarusComposerSubmitInput = z
  .object({
    projectId: z.string().min(1).max(MAX_SEGMENT_LENGTH),
    agentId: z.string().min(1).max(MAX_WIRE_STRING_ID),
    userId: z.string().min(1).max(MAX_WIRE_STRING_ID),
    content: z.string().min(1).max(1_000_000),
    messageType: z.string().max(MAX_WIRE_STRING_STATUS).optional(),
    fileRefs: ClarusComposerFileRefsSchema.optional(),
  })
  .meta({ ref: "ClarusComposerSubmitInput" })

const ClarusComposerSubmitResponse = z
  .object({
    requestID: z.string(),
    messageId: z.string(),
    projectId: z.string(),
    senderId: z.string(),
    userId: z.string().optional(),
    epoch: z.number(),
    generation: z.number(),
  })
  .meta({ ref: "ClarusComposerSubmitResponse" })

const ClarusErrorDetail = z
  .object({
    code: z.string(),
    message: z.string().max(MAX_WIRE_STRING_ERROR_MESSAGE),
    recoverable: z.boolean(),
    disposition: z.enum(["rejected", "ambiguous"]).optional(),
    reason: z
      .enum(["timeout", "aborted_after_dispatch", "disconnected", "invalid_response", "unexpected_response", "unknown"])
      .optional(),
  })
  .meta({ ref: "ClarusErrorDetail" })

// ── Reusable OpenAPI error response schemas ──────────────────

const clarusError400 = {
  description: "Clarus error",
  content: { "application/json": { schema: resolver(ClarusErrorDetail) } },
}
const clarusError404 = {
  description: "Clarus not found error",
  content: { "application/json": { schema: resolver(ClarusErrorDetail) } },
}
const clarusError409 = {
  description: "Clarus conflict error",
  content: { "application/json": { schema: resolver(ClarusErrorDetail) } },
}
const clarusError500 = {
  description: "Clarus ambiguous or server error",
  content: { "application/json": { schema: resolver(ClarusErrorDetail) } },
}

// ── Route dependency injection (test seam) ───────────────────

export type ClarusComposerTestDeps = {
  listUsers: typeof ClarusRuntime.listUsers
  status: typeof ClarusRuntime.status
  sendProjectMessage: typeof ClarusRuntime.sendProjectMessage
}

let composerDeps: ClarusComposerTestDeps | null = null

function getComposerDeps(): ClarusComposerTestDeps {
  return (
    composerDeps ?? {
      listUsers: ClarusRuntime.listUsers,
      status: ClarusRuntime.status,
      sendProjectMessage: ClarusRuntime.sendProjectMessage,
    }
  )
}

export function configureComposerTestDeps(deps: Partial<ClarusComposerTestDeps> | null): void {
  if (deps === null) {
    composerDeps = null
    return
  }
  composerDeps = { ...getComposerDeps(), ...deps }
}

// ── Bounded constants ───────────────────────────────────────

const DEFAULT_PAGE_LIMIT = 20
const MAX_PAGE_LIMIT = MAX_WIRE_PAGE_SIZE // 100
const COMPOSER_CANDIDATE_LIMIT = 5
const COMPOSER_TIMEOUT_MS = 30_000

// ── Navigation DTO schemas (strict allowlists, no z.unknown()) ────

const ClarusNavigationProjectDto = z
  .object({
    projectId: z.string(),
    projectName: z.string().optional(),
    projectSlug: z.string().optional(),
    activeGroup: z.boolean(),
    projectStatus: z.string().optional(),
    primaryAgent: z.string().nullable().optional(),
    lastProjectActivityAt: z.number().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .meta({ ref: "ClarusNavigationProjectDto" })

const ClarusNavigationTaskDto = z
  .object({
    taskId: z.string(),
    projectId: z.string(),
    sessionID: z.string(),
    title: z.string(),
    status: z.string(),
    resultState: z.string(),
    phase: z.string(),
    attempt: z.number(),
    deadlineAt: z.string().nullable().optional(),
    contextHydration: z.string(),
    localContinuationEnabledAt: z.number().optional(),
    resultRecordedAt: z.number().optional(),
    runID: z.string(),
    subtaskID: z.string(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .meta({ ref: "ClarusNavigationTaskDto" })

const ClarusNavigationResponse = z
  .object({
    connection: z.object({
      status: z.enum(["disabled", "connected", "reconnecting", "sign_in_required", "sync_failed"]),
      agentId: z.string().nullable(),
      error: z.string().optional(),
    }),
    projects: ClarusNavigationProjectDto.array(),
    tasks: ClarusNavigationTaskDto.array(),
  })
  .meta({ ref: "ClarusNavigationResponse" })

// ── Navigation bounded constants ───────────────────────────────────

export const MAX_NAV_AGENTS = 16
export const MAX_NAV_PROJECT_PAGES = 5
export const MAX_NAV_PROJECTS = 500
export const MAX_NAV_TASK_PAGES = 3

// ── Helpers ─────────────────────────────────────────────────

function requireConnectedAgent(status: Awaited<ReturnType<typeof ClarusRuntime.status>>): string {
  if (status.status === "disabled") {
    throw createError("CLARUS_DISABLED", "Clarus is not enabled in the current configuration.", false)
  }
  if (status.status === "disconnected") {
    throw createError("CLARUS_NOT_CONNECTED", "Clarus is not connected. Start Holos and enable Clarus.", false)
  }
  if (status.status === "connecting") {
    throw createError("CLARUS_CONNECTING", "Clarus connection is still being established. Retry shortly.", true)
  }
  if (status.status === "blocked") {
    throw createError("CLARUS_BLOCKED", status.error ?? "Clarus connection is blocked.", false)
  }
  // connected or reconnecting — proceed
  return status.agentId ?? ""
}

export function redactErrorMessage(message: string): string {
  return message
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
    .replace(/[\r\n]/g, " ")
    .replace(/https?:\/\/[^\s]*/gi, "[redacted-url]")
    .replace(/wss?:\/\/[^\s]*/gi, "[redacted-url]")
    .replace(/Bearer\s+[A-Za-z0-9._\-\+\/=]+/gi, "[redacted-token]")
    .replace(/sk-[A-Za-z0-9]+/gi, "[redacted-token]")
    .replace(/~\/[^\s]*/g, "[redacted-path]")
    .replace(/\/home\/[^\s]*/g, "[redacted-path]")
    .replace(/\/etc\/[^\s]*/g, "[redacted-path]")
    .replace(/\/tmp\/[^\s]*/g, "[redacted-path]")
    .replace(/\/var\/[^\s]*/g, "[redacted-path]")
    .replace(/\/usr\/[^\s]*/g, "[redacted-path]")
    .replace(/[A-Z]:\\([^\s]*)/gi, "[redacted-path]")
    .replace(/\\\\[^\s]*/g, "[redacted-path]")
    .replace(/scope[_-]?[0-9a-f]{40}/gi, "[redacted-id]")
    .replace(/ses[_-][0-9a-f]{16,}/gi, "[redacted-id]")
}

function createError(
  code: string,
  message: string,
  recoverable: boolean,
  opts?: { disposition?: "rejected" | "ambiguous"; reason?: string },
): { code: string; message: string; recoverable: boolean; disposition?: string; reason?: string } {
  return {
    code,
    message: redactErrorMessage(message),
    recoverable,
    ...(opts?.disposition ? { disposition: opts.disposition } : {}),
    ...(opts?.reason ? { reason: opts.reason } : {}),
  }
}

function errorResponse(
  c: any,
  status: number,
  code: string,
  message: string,
  recoverable: boolean,
  opts?: { disposition?: "rejected" | "ambiguous"; reason?: string },
) {
  return c.json(createError(code, message, recoverable, opts), status as any)
}

function validateIdParam(value: string, name: string): string {
  try {
    return validateSegment(value)
  } catch {
    throw createError("CLARUS_INVALID_ID", `${name} is invalid or exceeds its length limit`, false)
  }
}

// ── Binding helpers ─────────────────────────────────────────

function toBindingItem(b: ClarusProjectBindingV3): z.infer<typeof ClarusProjectBindingItem> {
  return {
    agentId: b.agentId,
    projectId: b.projectId,
    lifecycle: b.lifecycle,
    projectName: b.projectName,
    projectSlug: b.projectSlug,
    projectStatus: b.projectStatus,
    primaryAgent: b.primaryAgent,
    desiredSubscription: b.desiredSubscription,
    messageCursor: b.messageCursor,
    lastProjectActivityAt: b.lastProjectActivityAt,
    lastReconciliationAt: b.lastReconciliationAt,
    lastReconciliationError: b.lastReconciliationError,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
  }
}

function toTaskBindingItem(b: ClarusTaskBindingV4): z.infer<typeof ClarusTaskBindingItem> {
  return {
    agentId: b.agentId,
    projectId: b.projectId,
    taskId: b.taskId,
    sessionID: b.sessionID,
    runID: b.runID,
    subtaskID: b.subtaskID,
    phase: b.phase,
    attempt: b.attempt,
    deadlineAt: b.deadlineAt,
    title: b.title,
    status: b.status,
    resultState: b.resultState,
    contextHydration: b.contextHydration,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
  }
}

// ── Route ───────────────────────────────────────────────────

export const ClarusRoute = new Hono()
  // ── Status ──────────────────────────────────────────────────
  .get(
    "/status",
    describeRoute({
      summary: "Clarus connection status",
      description: "Get Clarus connection status and metadata for the current runtime.",
      operationId: "global.clarus.status",
      responses: {
        200: {
          description: "Clarus status",
          content: { "application/json": { schema: resolver(ClarusStatusResponse) } },
        },
      },
    }),
    async (c) => {
      const s = await ClarusRuntime.status()
      return c.json(s)
    },
  )

  // ── Reconnect ───────────────────────────────────────────────
  .post(
    "/reconnect",
    describeRoute({
      summary: "Reconnect Clarus",
      description: "Attempt to force a Clarus reconnection cycle. Returns full status after the attempt.",
      operationId: "global.clarus.reconnect",
      responses: {
        200: {
          description: "Full Clarus status after reconnect attempt",
          content: { "application/json": { schema: resolver(ClarusReconnectResponse) } },
        },
      },
    }),
    async (c) => {
      const s = await ClarusRuntime.reconnect()
      return c.json(s)
    },
  )

  // ── Projects — List ────────────────────────────────────────
  .get(
    "/projects",
    describeRoute({
      summary: "List Clarus project bindings",
      description: "List Clarus project bindings for the connected agent, bounded by cursor.",
      operationId: "global.clarus.projects.list",
      responses: {
        200: {
          description: "Bounded project bindings",
          content: { "application/json": { schema: resolver(ClarusProjectBindingListResponse) } },
        },
        400: clarusError400,
      },
    }),
    validator(
      "query",
      z.object({
        cursor: z.string().max(MAX_WIRE_STRING_CURSOR).optional(),
        limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).optional().default(DEFAULT_PAGE_LIMIT),
      }),
    ),
    async (c) => {
      const q = c.req.valid("query")
      try {
        const status = await ClarusRuntime.status()
        const agentId = requireConnectedAgent(status)
        const page = await ClarusBindingStore.listBindingsBounded(agentId, { cursor: q.cursor, limit: q.limit })
        return c.json({
          items: page.items.map(toBindingItem),
          nextCursor: page.nextCursor,
        })
      } catch (err: any) {
        if (typeof err.code === "string") {
          return errorResponse(c, 400, err.code, err.message, err.recoverable ?? false)
        }
        return errorResponse(c, 400, "CLARUS_LIST_ERROR", err?.message ?? "Failed to list project bindings", false)
      }
    },
  )

  // ── Projects — Get ─────────────────────────────────────────
  .get(
    "/projects/:projectId",
    describeRoute({
      summary: "Get a Clarus project binding",
      description: "Get a single Clarus project binding by project ID.",
      operationId: "global.clarus.projects.get",
      responses: {
        200: {
          description: "Project binding",
          content: { "application/json": { schema: resolver(ClarusProjectBindingItem) } },
        },
        400: clarusError400,
        404: clarusError404,
      },
    }),
    async (c) => {
      const projectId = c.req.param("projectId")
      try {
        validateIdParam(projectId, "projectId")
        const status = await ClarusRuntime.status()
        const agentId = requireConnectedAgent(status)
        const binding = await ClarusBindingStore.readV3(agentId, projectId)
        if (!binding) {
          return errorResponse(c, 404, "CLARUS_NOT_FOUND", `Project binding not found: ${projectId}`, false)
        }
        return c.json(toBindingItem(binding))
      } catch (err: any) {
        if (typeof err.code === "string") {
          return errorResponse(
            c,
            err.code === "CLARUS_NOT_FOUND" ? 404 : 400,
            err.code,
            err.message,
            err.recoverable ?? false,
          )
        }
        return errorResponse(c, 400, "CLARUS_GET_ERROR", err?.message ?? "Failed to get project binding", false)
      }
    },
  )

  // ── Projects — Create ──────────────────────────────────────
  .post(
    "/projects",
    describeRoute({
      summary: "Create or activate a Clarus project binding",
      description: "Create or activate a Clarus project binding for the connected agent.",
      operationId: "global.clarus.projects.create",
      responses: {
        200: {
          description: "Created or activated project binding",
          content: { "application/json": { schema: resolver(ClarusProjectBindingItem) } },
        },
        400: clarusError400,
      },
    }),
    validator("json", ClarusProjectBindingCreateInput),
    async (c) => {
      const input = c.req.valid("json")
      try {
        validateIdParam(input.projectId, "projectId")
        if (input.primaryAgent) validateSegment(input.primaryAgent)

        const status = await ClarusRuntime.status()
        const agentId = requireConnectedAgent(status)

        const binding = await ClarusBindingStore.reconcileBinding({
          agentId,
          projectId: input.projectId,
          projectName: input.projectName,
          projectSlug: input.projectSlug,
          projectStatus: input.projectStatus ?? "active",
          primaryAgent: input.primaryAgent ?? null,
        })
        // Read back the actual persisted state
        const stored = await ClarusBindingStore.readV3(agentId, input.projectId)
        return c.json(toBindingItem(stored ?? binding))
      } catch (err: any) {
        if (typeof err.code === "string") {
          return errorResponse(c, 400, err.code, err.message, err.recoverable ?? false)
        }
        return errorResponse(c, 400, "CLARUS_CREATE_ERROR", err?.message ?? "Failed to create project binding", false)
      }
    },
  )

  // ── Projects — Update ──────────────────────────────────────
  .put(
    "/projects/:projectId",
    describeRoute({
      summary: "Update a Clarus project binding",
      description: "Update metadata for a Clarus project binding.",
      operationId: "global.clarus.projects.update",
      responses: {
        200: {
          description: "Updated project binding",
          content: { "application/json": { schema: resolver(ClarusProjectBindingItem) } },
        },
        400: clarusError400,
        404: clarusError404,
      },
    }),
    validator("json", ClarusProjectBindingUpdateInput),
    async (c) => {
      const projectId = c.req.param("projectId")
      const input = c.req.valid("json")
      try {
        validateIdParam(projectId, "projectId")
        if (input.primaryAgent) validateSegment(input.primaryAgent)

        const status = await ClarusRuntime.status()
        const agentId = requireConnectedAgent(status)

        const existing = await ClarusBindingStore.readV3(agentId, projectId)
        if (!existing) {
          return errorResponse(c, 404, "CLARUS_NOT_FOUND", `Project binding not found: ${projectId}`, false)
        }
        const binding = await ClarusBindingStore.reconcileMetadata({
          agentId,
          projectId,
          projectName: input.projectName ?? existing.projectName ?? "",
          ...(input.projectSlug !== undefined ? { projectSlug: input.projectSlug } : {}),
          projectStatus: input.projectStatus ?? existing.projectStatus ?? "active",
          primaryAgent: input.primaryAgent,
        })

        if (!binding) {
          return errorResponse(c, 404, "CLARUS_NOT_FOUND", `Project binding not found: ${projectId}`, false)
        }

        // Read back the actual persisted state
        const stored = await ClarusBindingStore.readV3(agentId, projectId)
        return c.json(toBindingItem(stored ?? binding))
      } catch (err: any) {
        if (typeof err.code === "string") {
          return errorResponse(
            c,
            err.code === "CLARUS_NOT_FOUND" ? 404 : 400,
            err.code,
            err.message,
            err.recoverable ?? false,
          )
        }
        return errorResponse(c, 400, "CLARUS_UPDATE_ERROR", err?.message ?? "Failed to update project binding", false)
      }
    },
  )

  // ── Projects — Deactivate ──────────────────────────────────
  .post(
    "/projects/:projectId/deactivate",
    describeRoute({
      summary: "Deactivate a Clarus project binding",
      description: "Set a Clarus project binding to inactive (archived). Idempotent.",
      operationId: "global.clarus.projects.deactivate",
      responses: {
        200: {
          description: "Deactivated project binding",
          content: { "application/json": { schema: resolver(ClarusProjectBindingItem) } },
        },
        400: clarusError400,
      },
    }),
    async (c) => {
      const projectId = c.req.param("projectId")
      try {
        validateIdParam(projectId, "projectId")
        const status = await ClarusRuntime.status()
        const agentId = requireConnectedAgent(status)
        await ClarusBindingStore.setInactive(agentId, projectId)
        const binding = await ClarusBindingStore.readV3(agentId, projectId)
        return c.json(
          toBindingItem(
            binding ?? {
              schemaVersion: 3 as const,
              agentId,
              projectId,
              lifecycle: "archived" as const,
              desiredSubscription: false,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
          ),
        )
      } catch (err: any) {
        if (typeof err.code === "string") {
          return errorResponse(c, 400, err.code, err.message, err.recoverable ?? false)
        }
        return errorResponse(
          c,
          400,
          "CLARUS_DEACTIVATE_ERROR",
          err?.message ?? "Failed to deactivate project binding",
          false,
        )
      }
    },
  )

  // ── Projects — Activity ────────────────────────────────────
  .get(
    "/projects/:projectId/activity",
    describeRoute({
      summary: "List project activity",
      description:
        "List paginated activity records for a Clarus project in chronological order. " +
        "Forward-only cursor; insertions after the cursor appear on subsequent pages. " +
        "Unknown/malformed cursors resume from the beginning. Default limit 20, max 100.",
      operationId: "global.clarus.projects.activity",
      responses: {
        200: {
          description: "Paginated project activity",
          content: { "application/json": { schema: resolver(ClarusProjectActivityResponse) } },
        },
        400: clarusError400,
        404: clarusError404,
      },
    }),
    validator(
      "query",
      z.object({
        cursor: z.string().max(MAX_WIRE_STRING_CURSOR).optional(),
        limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).optional().default(DEFAULT_PAGE_LIMIT),
      }),
    ),
    async (c) => {
      const projectId = c.req.param("projectId")
      try {
        validateIdParam(projectId, "projectId")
        const q = c.req.valid("query")
        const status = await ClarusRuntime.status()
        const agentId = requireConnectedAgent(status)
        const result = await ClarusProjectActivityStore.listByProjectPaginated(agentId, projectId, {
          limit: q.limit,
          cursor: q.cursor,
        })
        return c.json(result)
      } catch (err: any) {
        if (typeof err.code === "string") {
          return errorResponse(c, 400, err.code, err.message, err.recoverable ?? false)
        }
        return errorResponse(c, 400, "CLARUS_ACTIVITY_ERROR", err?.message ?? "Failed to list project activity", false)
      }
    },
  )

  // ── Tasks — List ───────────────────────────────────────────
  .get(
    "/tasks",
    describeRoute({
      summary: "List Clarus task bindings",
      description:
        "List task bindings for the connected agent, scoped to a specific project. " +
        "A projectId query parameter is required.",
      operationId: "global.clarus.tasks.list",
      responses: {
        200: {
          description: "Task bindings",
          content: { "application/json": { schema: resolver(ClarusTaskBindingListResponse) } },
        },
        400: clarusError400,
      },
    }),
    validator(
      "query",
      z.object({
        projectId: z.string().max(MAX_SEGMENT_LENGTH),
        cursor: z.string().max(MAX_WIRE_STRING_CURSOR).optional(),
        limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).optional().default(DEFAULT_PAGE_LIMIT),
      }),
    ),
    async (c) => {
      const q = c.req.valid("query")
      try {
        validateSegment(q.projectId)
        const status = await ClarusRuntime.status()
        const agentId = requireConnectedAgent(status)

        const page = await ClarusTaskBindingStore.listTaskBindingsBounded(agentId, {
          projectId: q.projectId,
          limit: q.limit,
          cursor: q.cursor,
        })
        const items = page.items.map(toTaskBindingItem)
        return c.json({
          items,
          nextCursor: page.nextCursor,
          total: items.length,
        })
      } catch (err: any) {
        if (typeof err.code === "string") {
          return errorResponse(c, 400, err.code, err.message, err.recoverable ?? false)
        }
        return errorResponse(c, 400, "CLARUS_TASK_LIST_ERROR", err?.message ?? "Failed to list task bindings", false)
      }
    },
  )

  // ── Tasks — Get ────────────────────────────────────────────
  .get(
    "/tasks/:taskId",
    describeRoute({
      summary: "Get a Clarus task binding",
      description: "Get a single Clarus task binding by task ID and project ID.",
      operationId: "global.clarus.tasks.get",
      responses: {
        200: {
          description: "Task binding",
          content: { "application/json": { schema: resolver(ClarusTaskBindingItem) } },
        },
        400: clarusError400,
        404: clarusError404,
      },
    }),
    validator(
      "query",
      z.object({
        projectId: z.string().max(MAX_SEGMENT_LENGTH),
      }),
    ),
    async (c) => {
      const taskId = c.req.param("taskId")
      const q = c.req.valid("query")
      try {
        validateIdParam(taskId, "taskId")
        validateSegment(q.projectId)
        const status = await ClarusRuntime.status()
        const agentId = requireConnectedAgent(status)
        const binding = await ClarusTaskBindingStore.get(agentId, q.projectId, taskId)
        if (!binding) {
          return errorResponse(c, 404, "CLARUS_NOT_FOUND", `Task binding not found: ${taskId}`, false)
        }
        return c.json(toTaskBindingItem(binding))
      } catch (err: any) {
        if (typeof err.code === "string") {
          return errorResponse(
            c,
            err.code === "CLARUS_NOT_FOUND" ? 404 : 400,
            err.code,
            err.message,
            err.recoverable ?? false,
          )
        }
        return errorResponse(c, 400, "CLARUS_TASK_GET_ERROR", err?.message ?? "Failed to get task binding", false)
      }
    },
  )

  // ── Composer — Lookup Users ────────────────────────────────
  .get(
    "/composer/users",
    describeRoute({
      summary: "Lookup composer users",
      description:
        "Look up available users for the composer. Returns at most 5 candidates matching the search term. " +
        "Fields: userId (owner_id), userName, agentId. No profile/agent_key leakage.",
      operationId: "global.clarus.composer.lookupUsers",
      responses: {
        200: {
          description: "Matching user candidates",
          content: {
            "application/json": {
              schema: resolver(ClarusComposerUserItem.array()),
            },
          },
        },
        400: clarusError400,
      },
    }),
    validator(
      "query",
      z.object({
        search: z.string().max(MAX_WIRE_STRING_TITLE).optional().default(""),
        limit: z.coerce
          .number()
          .int()
          .min(1)
          .max(COMPOSER_CANDIDATE_LIMIT)
          .optional()
          .default(COMPOSER_CANDIDATE_LIMIT),
      }),
    ),
    async (c) => {
      try {
        const { search, limit } = c.req.valid("query")
        const deps = getComposerDeps()
        const candidates = await deps.listUsers({ search, limit, signal: c.req.raw.signal })
        return c.json(candidates)
      } catch (err: any) {
        if (typeof err.code === "string") {
          return errorResponse(c, 400, err.code, err.message, err.recoverable ?? false)
        }
        return errorResponse(c, 400, "CLARUS_COMPOSER_USERS_ERROR", err?.message ?? "Failed to lookup users", false)
      }
    },
  )

  // ── Composer — Lookup Projects ─────────────────────────────
  .get(
    "/composer/projects",
    describeRoute({
      summary: "Lookup composer projects",
      description:
        "Look up active projects for the composer from the connected agent's project bindings. " +
        "Returns at most 5 candidates matching the search term.",
      operationId: "global.clarus.composer.lookupProjects",
      responses: {
        200: {
          description: "Matching project candidates",
          content: {
            "application/json": {
              schema: resolver(ClarusComposerProjectItem.array()),
            },
          },
        },
        400: clarusError400,
      },
    }),
    validator(
      "query",
      z.object({
        search: z.string().max(MAX_WIRE_STRING_TITLE).optional().default(""),
        limit: z.coerce
          .number()
          .int()
          .min(1)
          .max(COMPOSER_CANDIDATE_LIMIT)
          .optional()
          .default(COMPOSER_CANDIDATE_LIMIT),
      }),
    ),
    async (c) => {
      try {
        const { search, limit } = c.req.valid("query")
        const status = await ClarusRuntime.status()
        const agentId = requireConnectedAgent(status)

        // Use bounded listing to get active bindings
        const page = await ClarusBindingStore.listBindingsBounded(agentId, { limit: MAX_PAGE_LIMIT })
        const active = page.items.filter((b) => b.lifecycle === "active")
        const projects = active.map((b) => ({
          projectId: b.projectId,
          projectName: b.projectName ?? b.projectId,
        }))

        const term = search.toLowerCase()
        const filtered = term
          ? projects.filter(
              (p) => p.projectName.toLowerCase().includes(term) || p.projectId.toLowerCase().includes(term),
            )
          : projects

        return c.json(filtered.slice(0, Math.min(limit, COMPOSER_CANDIDATE_LIMIT)))
      } catch (err: any) {
        if (typeof err.code === "string") {
          return errorResponse(c, 400, err.code, err.message, err.recoverable ?? false)
        }
        return errorResponse(
          c,
          400,
          "CLARUS_COMPOSER_PROJECTS_ERROR",
          err?.message ?? "Failed to lookup projects",
          false,
        )
      }
    },
  )

  // ── Composer — Submit ──────────────────────────────────────
  .post(
    "/composer/submit",
    describeRoute({
      summary: "Submit a composer message",
      description:
        "Validate the selected user/agent pair against current project bindings, " +
        "allocate a requestID, and call ClarusRuntime.sendProjectMessage() exactly once " +
        "with a 30s max timeout. Returns reconciliation identifiers. " +
        "Ambiguous outcomes surface as structured recoverable/non-retry errors per Scheme A.",
      operationId: "global.clarus.composer.submit",
      responses: {
        200: {
          description: "Submission result with reconciliation identifiers",
          content: { "application/json": { schema: resolver(ClarusComposerSubmitResponse) } },
        },
        400: clarusError400,
        404: clarusError404,
        409: clarusError409,
        500: clarusError500,
      },
    }),
    validator("json", ClarusComposerSubmitInput),
    async (c) => {
      const input = c.req.valid("json")
      try {
        const deps = getComposerDeps()
        const status = await deps.status()
        requireConnectedAgent(status)

        // Validate the project binding exists and is active
        const binding = await ClarusBindingStore.readV3(input.agentId, input.projectId)
        if (!binding) {
          return errorResponse(c, 404, "CLARUS_NOT_FOUND", `Project binding not found: ${input.projectId}`, false)
        }
        if (binding.lifecycle !== "active") {
          return errorResponse(c, 400, "CLARUS_PROJECT_INACTIVE", `Project is not active: ${input.projectId}`, false)
        }

        // Validate the chosen user/agent pair freshly via listUsers

        const candidates = await deps.listUsers({ search: input.userId, limit: COMPOSER_CANDIDATE_LIMIT })
        const validPair = candidates.some((c) => c.userId === input.userId && c.agentId === input.agentId)
        if (!validPair) {
          return errorResponse(
            c,
            400,
            "CLARUS_USER_NOT_MEMBER",
            `User ${input.userId} with agent ${input.agentId} is not valid for this project`,
            false,
          )
        }

        // Allocate a requestID and send exactly once
        const requestID = crypto.randomUUID()
        try {
          const result = await deps.sendProjectMessage({
            requestID,
            agentId: input.agentId,
            projectId: input.projectId,
            content: input.content,
            messageType: input.messageType,
            fileRefs: input.fileRefs,
            userId: input.userId,
            timeoutMs: COMPOSER_TIMEOUT_MS,
            signal: c.req.raw.signal,
          })
          return c.json({
            requestID: result.requestID,
            messageId: result.messageId,
            projectId: result.projectId,
            senderId: result.senderId,
            userId: result.userId,
            epoch: result.epoch,
            generation: result.generation,
          })
        } catch (sendErr: any) {
          // Map Scheme A disposition to structured error
          if (sendErr.disposition === "rejected") {
            return errorResponse(
              c,
              400,
              sendErr.code ?? "CLARUS_SUBMIT_REJECTED",
              sendErr.message ?? "Composer submission was rejected by the remote agent",
              false,
              { disposition: "rejected" },
            )
          }
          if (sendErr.disposition === "ambiguous") {
            return errorResponse(
              c,
              500,
              "CLARUS_SUBMIT_AMBIGUOUS",
              `Composer submission outcome is ambiguous: ${sendErr.reason ?? sendErr.message ?? "unknown"}. Do not retry automatically.`,
              false,
              { disposition: "ambiguous", reason: sendErr.reason ?? "unknown" },
            )
          }
          if (sendErr.code === "CLARUS_OUTBOX_COLLISION") {
            return errorResponse(c, 409, sendErr.code, sendErr.message, false)
          }
          throw sendErr
        }
      } catch (err: any) {
        if (typeof err.code === "string") {
          return errorResponse(c, 400, err.code, err.message, err.recoverable ?? false)
        }
        return errorResponse(
          c,
          500,
          "CLARUS_COMPOSER_SUBMIT_ERROR",
          err?.message ?? "Failed to submit composer message",
          false,
        )
      }
    },
  )

  // ── Navigation ───────────────────────────────────────────────
  .get(
    "/navigation",
    describeRoute({
      summary: "Clarus navigation snapshot",
      description:
        "Returns a bounded navigation snapshot from locally persisted bindings. " +
        "Works even when Clarus is disabled, signed out, reconnecting, or sync-failed.",
      operationId: "global.clarus.navigation",
      responses: {
        200: {
          description: "Bounded navigation snapshot",
          content: {
            "application/json": {
              schema: resolver(ClarusNavigationResponse),
            },
          },
        },
      },
    }),
    async (c) => {
      try {
        const runtimeStatus = await ClarusRuntime.status()
        const connection = {
          status: toNavigationConnectionStatus(runtimeStatus),
          agentId: runtimeStatus.agentId,
          error: runtimeStatus.error,
        }

        // Discover agent IDs: prefer connected, scan disk for persisted bindings
        // Capped at MAX_NAV_AGENTS — deterministic selection of first N.
        const agentIds = new Set<string>()
        if (runtimeStatus.agentId) agentIds.add(runtimeStatus.agentId)
        try {
          const rootPath = StoragePath.clarusBindingsRoot()
          const keys = await Storage.scan(rootPath)
          for (const k of keys) {
            agentIds.add(decodeURIComponent(k))
            if (agentIds.size >= MAX_NAV_AGENTS) break
          }
        } catch {
          /* best-effort */
        }

        // Collect projects from all discovered agents — hard-bounded pages/items
        const allProjects: ClarusProjectBindingV3[] = []
        for (const agentId of agentIds) {
          let projectCursor: string | undefined
          for (let pp = 0; pp < MAX_NAV_PROJECT_PAGES && allProjects.length < MAX_NAV_PROJECTS; pp++) {
            const page = await ClarusBindingStore.listBindingsBounded(agentId, {
              limit: MAX_PAGE_LIMIT,
              cursor: projectCursor,
            })
            if (page.items.length === 0) break
            const room = MAX_NAV_PROJECTS - allProjects.length
            allProjects.push(...page.items.slice(0, room))
            if (!page.nextCursor) break
            projectCursor = page.nextCursor
          }
        }

        const activeProjects = allProjects.filter((p) => p.lifecycle === "active")
        const inactiveProjects = allProjects.filter((p) => p.lifecycle !== "active")
        const inactiveWithHistory = inactiveProjects.filter((p) => p.lastProjectActivityAt !== undefined)
        const projectDtos = [...activeProjects, ...inactiveWithHistory].map(toNavigationProjectDto)

        // Tasks from active projects — group once by agent (O(A+P) not O(A×P))
        const projectsByAgent = new Map<string, ClarusProjectBindingV3[]>()
        for (const project of activeProjects) {
          const list = projectsByAgent.get(project.agentId)
          if (list) list.push(project)
          else projectsByAgent.set(project.agentId, [project])
        }

        const allTaskDtos: ReturnType<typeof toNavigationTaskDto>[] = []
        for (const agentId of agentIds) {
          const agentProjects = projectsByAgent.get(agentId)
          if (!agentProjects) continue
          for (const project of agentProjects) {
            let taskCursor: string | undefined
            for (let tp = 0; tp < MAX_NAV_TASK_PAGES; tp++) {
              const taskPage = await ClarusTaskBindingStore.listTaskBindingsBounded(agentId, {
                projectId: project.projectId,
                limit: MAX_PAGE_LIMIT,
                cursor: taskCursor,
              })
              if (taskPage.items.length === 0) break
              allTaskDtos.push(...taskPage.items.map(toNavigationTaskDto))
              if (!taskPage.nextCursor) break
              taskCursor = taskPage.nextCursor
            }
          }
        }

        return c.json({ connection, projects: projectDtos, tasks: sortTasksByPriority(allTaskDtos) })
      } catch {
        return c.json({ connection: { status: "disabled" as const, agentId: null }, projects: [], tasks: [] })
      }
    },
  )

  // ── Safe Task Detail ─────────────────────────────────────────
  .get(
    "/projects/:projectId/tasks/:taskId",
    describeRoute({
      summary: "Get safe bounded task detail",
      description:
        "Returns safe bounded task detail for header/composer use. " +
        "Includes sessionID solely for HOME_SCOPE_KEY routing, bounded runID/taskId, " +
        "display identity, phase, attempt, deadline, title, exact status/result/context enums, " +
        "bounded assignment summary, local continuation state, and timestamps. " +
        "Excludes workspacePath, scopeID, frozenAgent, raw task input/instructions/metadata/outbox/storage records, " +
        "credentials, and unrestricted internal IDs.",
      operationId: "global.clarus.projects.taskDetail",
      responses: {
        200: {
          description: "Safe bounded task detail",
          content: { "application/json": { schema: resolver(z.record(z.string(), z.unknown())) } },
        },
        400: clarusError400,
        404: clarusError404,
      },
    }),
    async (c) => {
      const projectId = c.req.param("projectId")
      const taskId = c.req.param("taskId")
      try {
        validateIdParam(projectId, "projectId")
        validateIdParam(taskId, "taskId")
        const status = await ClarusRuntime.status()
        const agentId = requireConnectedAgent(status)
        const binding = await ClarusTaskBindingStore.get(agentId, projectId, taskId)
        if (!binding) {
          return errorResponse(c, 404, "CLARUS_NOT_FOUND", `Task binding not found: ${taskId}`, false)
        }
        return c.json(toNavigationTaskDto(binding))
      } catch (err: any) {
        if (typeof err.code === "string") {
          return errorResponse(
            c,
            err.code === "CLARUS_NOT_FOUND" ? 404 : 400,
            err.code,
            err.message,
            err.recoverable ?? false,
          )
        }
        return errorResponse(c, 400, "CLARUS_TASK_DETAIL_ERROR", err?.message ?? "Failed to get task detail", false)
      }
    },
  )

  // ── Continue-Local ───────────────────────────────────────────
  .post(
    "/projects/:projectId/tasks/:taskId/continue-local",
    describeRoute({
      summary: "Enable local continuation for a task",
      description:
        "Allowed only when status is 'submitted' and resultState is 'acknowledged'. " +
        "Idempotently persists localContinuationEnabledAt and resultState = local_only. " +
        "Already local-only tasks return the existing binding. " +
        "Works for already-local-only tasks (idempotent) and acknowledged/submitted tasks.",
      operationId: "global.clarus.projects.continueLocal",
      responses: {
        200: {
          description: "Local continuation enabled",
          content: { "application/json": { schema: resolver(z.record(z.string(), z.unknown())) } },
        },
        400: clarusError400,
        404: clarusError404,
      },
    }),
    async (c) => {
      const projectId = c.req.param("projectId")
      const taskId = c.req.param("taskId")
      try {
        validateIdParam(projectId, "projectId")
        validateIdParam(taskId, "taskId")
        const status = await ClarusRuntime.status()
        const agentId = requireConnectedAgent(status)

        const binding = await ClarusTaskBindingStore.get(agentId, projectId, taskId)
        if (!binding) {
          return errorResponse(c, 404, "CLARUS_NOT_FOUND", `Task binding not found: ${taskId}`, false)
        }

        // Already local_only — idempotent success
        if (binding.resultState === "local_only") {
          return c.json(toNavigationTaskDto(binding))
        }

        // Eligibility: must be submitted + acknowledged
        if (binding.status !== "submitted" || binding.resultState !== "acknowledged") {
          return errorResponse(
            c,
            400,
            "CLARUS_CONTINUE_LOCAL_INELIGIBLE",
            `Task ${taskId} is not eligible for local continuation. Status: ${binding.status}, resultState: ${binding.resultState}`,
            false,
          )
        }

        const updated = await ClarusTaskBindingStore.enableLocalContinuation(agentId, projectId, taskId)
        void Bus.publish(NavigationUpdated, { timestamp: Date.now() })
        if (!updated) {
          // enableLocalContinuation returns undefined if already set — re-read
          const reRead = await ClarusTaskBindingStore.get(agentId, projectId, taskId)
          if (!reRead) {
            return errorResponse(c, 404, "CLARUS_NOT_FOUND", `Task binding not found: ${taskId}`, false)
          }
          return c.json(toNavigationTaskDto(reRead))
        }
        return c.json(toNavigationTaskDto(updated))
      } catch (err: any) {
        if (typeof err.code === "string") {
          return errorResponse(c, 400, err.code, err.message, err.recoverable ?? false)
        }
        return errorResponse(
          c,
          400,
          "CLARUS_CONTINUE_LOCAL_ERROR",
          err?.message ?? "Failed to enable local continuation",
          false,
        )
      }
    },
  )
