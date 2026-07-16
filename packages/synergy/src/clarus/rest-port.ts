import z from "zod"

// ── Bounds constants (shared with rest-client) ──────────

export const MAX_WIRE_STRING_ID = 512
export const MAX_WIRE_STRING_TITLE = 512
export const MAX_WIRE_STRING_STATUS = 128
export const MAX_WIRE_STRING_ROLE = 64
export const MAX_WIRE_STRING_DATE = 64
export const MAX_WIRE_STRING_SLUG = 512
export const MAX_WIRE_STRING_MESSAGE_TYPE = 128
export const MAX_WIRE_STRING_CONTENT = 1_000_000
export const MAX_WIRE_STRING_CURSOR = 1024
export const MAX_WIRE_PAGE_SIZE = 100
export const MAX_WIRE_METADATA_KEYS = 50
export const MAX_WIRE_METADATA_KEY_LENGTH = 128
export const MAX_WIRE_METADATA_RECURSION_DEPTH = 3
export const MAX_WIRE_FILE_REFS = 50
export const MAX_WIRE_FILE_REF_RECURSION_DEPTH = 3
export const MAX_WIRE_RESPONSE_BYTES = 2 * 1024 * 1024
export const MAX_WIRE_STRING_ERROR_MESSAGE = 500
export const MAX_WIRE_PAYLOAD_AGGREGATE_BYTES = 65536
export const MAX_WIRE_STRING_USER_QUERY = 256
export const MAX_USER_CANDIDATES = 5

export namespace ClarusRestPort {
  // ── Wire schemas (snake_case) for adapter validation ──────────

  export const WireProjectItem = z
    .object({
      project_id: z.string().max(MAX_WIRE_STRING_ID),
      title: z.string().max(MAX_WIRE_STRING_TITLE),
      status: z.string().max(MAX_WIRE_STRING_STATUS),
      role: z.string().max(MAX_WIRE_STRING_ROLE),
      runtime_agent_id: z.string().max(MAX_WIRE_STRING_ID).nullable().optional(),
      updated_at: z.string().max(MAX_WIRE_STRING_DATE),
    })
    .passthrough()

  export const WireProjectListData = z.object({
    items: z.array(WireProjectItem),
    next_cursor: z.string().max(MAX_WIRE_STRING_CURSOR).nullable().optional(),
  })

  export const WireProjectDetail = z
    .object({
      project_id: z.string().max(MAX_WIRE_STRING_ID),
      title: z.string().max(MAX_WIRE_STRING_TITLE),
      status: z.string().max(MAX_WIRE_STRING_STATUS),
      role: z.string().max(MAX_WIRE_STRING_ROLE),
      runtime_agent_id: z.string().max(MAX_WIRE_STRING_ID).nullable().optional(),
      updated_at: z.string().max(MAX_WIRE_STRING_DATE),
      slug: z.string().max(MAX_WIRE_STRING_SLUG).optional(),
    })
    .passthrough()

  export const WireAgentItem = z
    .object({
      agent_id: z.string().max(MAX_WIRE_STRING_ID).optional(),
      agent_key: z.string().max(512).optional(),
      owner_id: z.string().max(MAX_WIRE_STRING_ID),
      owner_name: z.string().max(MAX_WIRE_STRING_TITLE),
      is_active: z.boolean(),
      profile: z.record(z.string(), z.unknown()).optional(),
    })
    .passthrough()

  export const WireAgentListData = z.object({
    items: z.array(WireAgentItem).max(MAX_WIRE_PAGE_SIZE),
    total: z.number().int().nonnegative(),
  })

  // ── Typed recursive value schemas for SDK structure ─────

  export const WireMetadataValue: z.ZodTypeAny = z.lazy(() =>
    z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.null(),
      z.array(z.lazy(() => ClarusRestPort.WireMetadataValue)),
      z.record(
        z.string(),
        z.lazy(() => ClarusRestPort.WireMetadataValue),
      ),
    ]),
  )

  export const WireFileRefValue: z.ZodTypeAny = z.lazy(() =>
    z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.null(),
      z.array(z.lazy(() => ClarusRestPort.WireFileRefValue)),
      z.record(
        z.string(),
        z.lazy(() => ClarusRestPort.WireFileRefValue),
      ),
    ]),
  )

  // ── Recursive bounds validators ─────────────────────────

  export function validateWireMetadata(
    raw: unknown,
    depth: number,
    maxKeys: number,
    maxKeyLength: number,
    maxDepth: number,
  ): Record<string, unknown> {
    if (depth > maxDepth) throw new Error("metadata exceeds recursion limit")
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("metadata is not a record")
    const obj = raw as Record<string, unknown>
    const keys = Object.keys(obj)
    if (keys.length > maxKeys) throw new Error("metadata key count exceeds limit")
    for (const key of keys) {
      if (key.length > maxKeyLength) throw new Error("metadata key exceeds length limit")
      const value = obj[key]
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        validateWireMetadata(value, depth + 1, maxKeys, maxKeyLength, maxDepth)
      } else if (Array.isArray(value)) {
        validateWireFileRefs(value, depth + 1, maxKeys)
      }
    }
    return obj
  }

  export function validateWireFileRefs(raw: unknown, depth: number, maxDepth: number): unknown[] {
    if (depth > maxDepth) throw new Error("fileRefs exceeds recursion limit")
    if (!Array.isArray(raw)) throw new Error("fileRefs is not an array")
    for (const item of raw) {
      if (item !== null && typeof item === "object" && !Array.isArray(item)) {
        validateWireMetadata(item as Record<string, unknown>, 2, maxDepth, maxDepth, maxDepth)
      } else if (Array.isArray(item)) {
        validateWireFileRefs(item, depth + 1, maxDepth)
      }
    }
    return raw
  }
  export const WireMessageItem = z
    .object({
      message_id: z.string().max(MAX_WIRE_STRING_ID),
      message_type: z.string().max(MAX_WIRE_STRING_MESSAGE_TYPE).optional(),
      content: z.string().max(MAX_WIRE_STRING_CONTENT).optional(),
      metadata: z.record(z.string().max(MAX_WIRE_METADATA_KEY_LENGTH), WireMetadataValue).optional(),
      file_refs: z.array(WireFileRefValue).optional(),
      created_at: z.string().max(MAX_WIRE_STRING_DATE).optional(),
    })
    .passthrough()

  export const WireMessageListData = z.object({
    messages: z.array(WireMessageItem),
    next_cursor: z.string().max(MAX_WIRE_STRING_CURSOR).nullable().optional(),
  })

  export const StandardResponse = z.object({
    code: z.number().int(),
    message: z.string().max(MAX_WIRE_STRING_ERROR_MESSAGE).optional(),
    data: z.unknown(),
  })

  // ── DTO types (camelCase) for internal consumption ───────────

  export interface ProjectSummaryDto {
    projectId: string
    title: string
    status: string
    role: string
    runtimeAgentId: string | null
    updatedAt: string
  }

  export interface ProjectDetailDto extends ProjectSummaryDto {
    slug?: string
  }

  export type DtoMetadataValue =
    | string
    | number
    | boolean
    | null
    | DtoMetadataValue[]
    | { [key: string]: DtoMetadataValue }

  export type DtoFileRefValue =
    | string
    | number
    | boolean
    | null
    | DtoFileRefValue[]
    | { [key: string]: DtoFileRefValue }

  export interface MessageDto {
    messageId: string
    messageType?: string
    metadata?: Record<string, unknown>
    fileRefs?: unknown[]
    createdAt?: string
    content?: string
  }

  export interface UserCandidateDto {
    userId: string
    userName: string
    agentId: string
  }

  // ── Narrow interface (agent identity is server-derived) ──────

  export interface Interface {
    listProjects(params: {
      status?: string
      limit?: number
      cursor?: string
    }): Promise<{ projects: ProjectSummaryDto[]; nextCursor: string | null }>
    getProject(params: { projectId: string }): Promise<ProjectDetailDto>
    listMessages(params: {
      projectId: string
      cursor?: string
      limit?: number
    }): Promise<{ messages: MessageDto[]; nextCursor: string | null }>
    listUsers(params: { query: string; limit?: number }): Promise<{ users: UserCandidateDto[] }>
  }
}
