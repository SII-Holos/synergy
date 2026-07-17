import { validateHolosEndpoint } from "@/holos/security"
import { normalizePublicHttpsOrigin } from "@/util/public-https-origin"
import { createFallbackFetcher } from "./fallback-transport"
import { ClarusIdSchema } from "./schemas"
import {
  ClarusRestPort,
  MAX_WIRE_PAGE_SIZE,
  MAX_WIRE_STRING_CURSOR,
  MAX_WIRE_STRING_STATUS,
  MAX_WIRE_RESPONSE_BYTES,
  MAX_WIRE_METADATA_KEYS,
  MAX_WIRE_METADATA_KEY_LENGTH,
  MAX_WIRE_METADATA_RECURSION_DEPTH,
  MAX_WIRE_FILE_REFS,
  MAX_WIRE_FILE_REF_RECURSION_DEPTH,
  MAX_WIRE_VALUE_STRING_LENGTH,
  MAX_WIRE_STRING_ERROR_MESSAGE,
  MAX_WIRE_STRING_USER_QUERY,
  MAX_USER_CANDIDATES,
  MAX_PAYLOAD_SNAPSHOT_BYTES,
} from "./rest-port"
import { validateSegment } from "./keys"
import type { ClarusCredentialSupplier } from "./config-reader"

const DEFAULT_TIMEOUT_MS = 15_000

// ── Input bounds (page/item limits separate from Wire schema constants) ──

const MAX_PROJECTS_PER_RESPONSE = 100
const MAX_MESSAGES_PER_RESPONSE = 100

// ── Types ─────────────────────────────────────────────────────

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

type Input = {
  apiUrl: string
  credentials: ClarusCredentialSupplier
  fetch?: Fetcher
  timeoutMs?: number
  maxResponseBytes?: number
}

// ── Helpers ───────────────────────────────────────────────────

function boundedString(value: string, max: number, name: string): string {
  if (value.length > max) throw new Error(`Clarus ${name} exceeds its limit`)
  return value
}

function validateCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined) return undefined
  return boundedString(cursor, MAX_WIRE_STRING_CURSOR, "cursor")
}

function validateLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_WIRE_PAGE_SIZE)
    throw new Error("Clarus page limit is out of bounds")
  return limit
}

function parseResponseBody(body: string, maxBytes: number): unknown {
  if (new TextEncoder().encode(body).byteLength > maxBytes) throw new Error("Clarus response body exceeds its limit")
  try {
    return JSON.parse(body)
  } catch {
    throw new Error("Clarus response body is not valid JSON")
  }
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) throw new Error("Clarus payload snapshot body is missing")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > maxBytes) throw new Error("Clarus payload snapshot exceeds its limit")
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const body = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

// ── Recursive bounds validators for metadata / fileRefs ─────

function validateMetadata(
  raw: unknown,
  depth: number,
  maxKeys: number,
  maxKeyLength: number,
  maxDepth: number,
  visited: WeakSet<object>,
): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Clarus metadata is not a record")
  if (visited.has(raw as object)) throw new Error("Clarus metadata contains a cycle")
  visited.add(raw as object)
  if (depth > maxDepth) {
    visited.delete(raw as object)
    throw new Error("Clarus metadata exceeds its recursion limit")
  }
  const obj = raw as Record<string, unknown>
  const keys = Object.keys(obj)
  if (keys.length > maxKeys) throw new Error("Clarus metadata key count exceeds its limit")
  for (const key of keys) {
    if (key.length > maxKeyLength) throw new Error("Clarus metadata key exceeds its limit")
    const value = obj[key]
    if (typeof value === "string" && value.length > MAX_WIRE_VALUE_STRING_LENGTH)
      throw new Error("Clarus metadata string exceeds its length limit")
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      validateMetadata(value, depth + 1, maxKeys, maxKeyLength, maxDepth, visited)
    } else if (Array.isArray(value)) {
      if (value.length > MAX_WIRE_FILE_REFS) throw new Error("Clarus metadata array exceeds its item limit")
      validateFileRefs(value, depth + 1, maxDepth, visited)
    }
  }
  return obj
}

function validateFileRefs(raw: unknown, depth: number, maxDepth: number, visited: WeakSet<object>): unknown[] {
  if (!Array.isArray(raw)) throw new Error("Clarus fileRefs is not an array")
  if (visited.has(raw as object)) throw new Error("Clarus fileRefs contains a cycle")
  visited.add(raw as object)
  if (depth > maxDepth) {
    visited.delete(raw as object)
    throw new Error("Clarus fileRefs exceeds its recursion limit")
  }
  if (raw.length > MAX_WIRE_FILE_REFS) throw new Error("Clarus fileRefs item count exceeds its limit")
  for (const item of raw) {
    if (typeof item === "string" && item.length > MAX_WIRE_VALUE_STRING_LENGTH)
      throw new Error("Clarus fileRefs string exceeds its length limit")
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      validateMetadata(
        item as Record<string, unknown>,
        depth + 1,
        MAX_WIRE_METADATA_KEYS,
        MAX_WIRE_METADATA_KEY_LENGTH,
        maxDepth,
        visited,
      )
    } else if (Array.isArray(item)) {
      validateFileRefs(item, depth + 1, maxDepth, visited)
    }
  }
  return raw
}

// ── Error redaction ─────────────────────────────────────────

function redactMessage(status: number, code?: number, message?: string): string {
  const safeCode = typeof code === "number" && Number.isInteger(code) ? ` code=${code}` : ""
  let safeMessage = "request failed"
  if (typeof message === "string") {
    safeMessage = message
      .replace(/[\r\n]/g, " ")
      .replace(/https?:\/\/[^\s]*/gi, "[redacted-url]")
      .replace(/(?:\/[\w.-]+)+/g, (match) => (match.length > 3 ? "[redacted-path]" : match))
      .replace(/[^\x20-\x7E\u00A0-\uFFFF]/g, "")
      .trim()
      .slice(0, MAX_WIRE_STRING_ERROR_MESSAGE)
  }
  return `Clarus REST request failed: status=${status}${safeCode} ${safeMessage}`
}

// ── Client ───────────────────────────────────────────────────

export class ClarusRestClient implements ClarusRestPort.Interface {
  private readonly baseUrl: URL
  private readonly credentials: ClarusCredentialSupplier
  private readonly fetcher: Fetcher
  private readonly snapshotFetcher: Fetcher
  private readonly objectFetcher: Fetcher
  private readonly timeoutMs: number
  private readonly maxResponseBytes: number

  constructor(input: Input) {
    const baseUrl = validateHolosEndpoint(input.apiUrl, "api")
    if (baseUrl.pathname !== "/" || baseUrl.search || baseUrl.hash) throw new Error("Clarus API URL must be an origin")
    this.baseUrl = baseUrl
    this.credentials = input.credentials
    const baseFetch = input.fetch ?? fetch
    this.fetcher = input.fetch ?? createFallbackFetcher(baseFetch, { connectTimeoutMs: input.timeoutMs })
    this.snapshotFetcher = input.fetch
      ? baseFetch
      : createFallbackFetcher(baseFetch, { connectTimeoutMs: input.timeoutMs, acceptedStatuses: [307] })
    this.objectFetcher = baseFetch
    this.timeoutMs = Math.min(Math.max(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1), DEFAULT_TIMEOUT_MS)
    this.maxResponseBytes = Math.min(
      Math.max(input.maxResponseBytes ?? MAX_WIRE_RESPONSE_BYTES, 1),
      MAX_WIRE_RESPONSE_BYTES,
    )
  }

  async listProjects(params: { status?: string; limit?: number; cursor?: string }) {
    const query = new URLSearchParams()
    if (params.status !== undefined) query.set("status", boundedString(params.status, MAX_WIRE_STRING_STATUS, "status"))
    const limit = validateLimit(params.limit)
    if (limit !== undefined) query.set("limit", String(limit))
    const cursor = validateCursor(params.cursor)
    if (cursor !== undefined) query.set("cursor", cursor)
    const data = await this.get("/api/v1/holos/clarus/projects", query)
    const parsed = ClarusRestPort.WireProjectListData.parse(data)
    if (parsed.items.length > MAX_PROJECTS_PER_RESPONSE) throw new Error("Clarus project page exceeds its limit")
    return {
      projects: parsed.items.map((item) => ({
        projectId: item.project_id,
        title: item.title,
        status: item.status,
        role: item.role,
        runtimeAgentId: item.runtime_agent_id ?? null,
        updatedAt: item.updated_at,
      })),
      nextCursor: parsed.next_cursor ?? null,
    }
  }

  async getProject(params: { projectId: string }) {
    const projectId = validateSegment(params.projectId)
    const data = await this.get(`/api/v1/holos/clarus/projects/${encodeURIComponent(projectId)}`)
    const item = ClarusRestPort.WireProjectDetail.parse(data)
    return {
      projectId: item.project_id,
      title: item.title,
      status: item.status,
      role: item.role,
      runtimeAgentId: item.runtime_agent_id ?? null,
      updatedAt: item.updated_at,
      ...(item.slug === undefined ? {} : { slug: item.slug }),
    }
  }

  async listMessages(params: { projectId: string; cursor?: string; limit?: number }) {
    const projectId = validateSegment(params.projectId)
    const query = new URLSearchParams()
    const limit = validateLimit(params.limit)
    if (limit !== undefined) query.set("limit", String(limit))
    const cursor = validateCursor(params.cursor)
    if (cursor !== undefined) query.set("cursor", cursor)
    const data = await this.get(`/api/v1/holos/clarus/projects/${encodeURIComponent(projectId)}/messages`, query)
    const parsed = ClarusRestPort.WireMessageListData.parse(data)
    if (parsed.items.length > MAX_MESSAGES_PER_RESPONSE) throw new Error("Clarus message page exceeds its limit")
    return {
      messages: parsed.items.map((item) => ({
        messageId: item.message_id,
        ...(item.message_type === undefined ? {} : { messageType: item.message_type }),
        ...(item.content === undefined ? {} : { content: item.content }),
        ...(item.metadata === undefined
          ? {}
          : {
              metadata: validateMetadata(
                item.metadata,
                1,
                MAX_WIRE_METADATA_KEYS,
                MAX_WIRE_METADATA_KEY_LENGTH,
                MAX_WIRE_METADATA_RECURSION_DEPTH,
                new WeakSet(),
              ),
            }),
        ...(item.file_refs === undefined
          ? {}
          : {
              fileRefs: validateFileRefs(item.file_refs, 1, MAX_WIRE_FILE_REF_RECURSION_DEPTH, new WeakSet()),
            }),
        ...(item.created_at === undefined ? {} : { createdAt: item.created_at }),
      })),
      nextCursor: parsed.next_cursor ?? null,
    }
  }

  async resolvePayloadSnapshot(params: ClarusRestPort.PayloadSnapshotRequest): Promise<Record<string, unknown>> {
    if (
      params.contentType !== "application/json" ||
      params.contentEncoding !== "gzip" ||
      !Number.isInteger(params.expectedBytes) ||
      params.expectedBytes < 1 ||
      params.expectedBytes > MAX_PAYLOAD_SNAPSHOT_BYTES ||
      !/^[0-9a-f]{64}$/i.test(params.expectedSha256)
    )
      throw new Error("Clarus payload snapshot reference is invalid")
    const credential = await this.credentials()
    if (!credential) throw new Error("Clarus credentials are unavailable")
    ClarusIdSchema.parse(credential.agentId)
    if (!credential.agentSecret || credential.agentSecret.length > 4096) throw new Error("Clarus credential is invalid")
    const downloadUrl = new URL(params.downloadUrl, this.baseUrl)
    if (downloadUrl.origin !== this.baseUrl.origin) throw new Error("Clarus payload snapshot URL changed origin")
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const redirect = await this.snapshotFetcher(
        new Request(downloadUrl, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${credential.agentSecret}`,
            "X-Agent-Id": credential.agentId,
          },
        }),
      )
      if (redirect.url && new URL(redirect.url).origin !== this.baseUrl.origin)
        throw new Error("Clarus payload snapshot URL changed origin")
      if (redirect.status !== 307) throw new Error("Clarus payload snapshot redirect is invalid")
      const location = redirect.headers.get("location")
      if (!location) throw new Error("Clarus payload snapshot redirect is missing")
      const objectUrl = new URL(location, downloadUrl)
      normalizePublicHttpsOrigin(objectUrl.origin)
      const response = await this.objectFetcher(
        new Request(objectUrl, {
          method: "GET",
          redirect: "error",
          signal: controller.signal,
          headers: { Accept: "application/json" },
        }),
      )
      if (!response.ok) throw new Error("Clarus payload snapshot download failed")
      if (response.url && new URL(response.url).origin !== objectUrl.origin)
        throw new Error("Clarus payload snapshot object redirect changed origin")
      const body = await readBoundedBody(response, MAX_PAYLOAD_SNAPSHOT_BYTES)
      if (body.byteLength !== params.expectedBytes) throw new Error("Clarus payload snapshot byte count mismatch")
      const hash = new Bun.CryptoHasher("sha256").update(body).digest("hex")
      if (hash.toLowerCase() !== params.expectedSha256.toLowerCase())
        throw new Error("Clarus payload snapshot checksum mismatch")
      const parsed = parseResponseBody(new TextDecoder().decode(body), MAX_PAYLOAD_SNAPSHOT_BYTES)
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("Clarus payload snapshot is not a record")
      return parsed as Record<string, unknown>
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Clarus")) throw error
      throw new Error("Clarus payload snapshot request failed")
    } finally {
      clearTimeout(timer)
    }
  }

  async listUsers(params: { query: string; limit?: number }) {
    const query = params.query
    if (query.length === 0) throw new Error("Clarus user query must not be empty")
    boundedString(query, MAX_WIRE_STRING_USER_QUERY, "user query")
    const limit = params.limit !== undefined ? params.limit : MAX_USER_CANDIDATES
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_USER_CANDIDATES)
      throw new Error("Clarus user lookup limit is out of bounds")

    const qp = new URLSearchParams()
    qp.set("need_active", "true")
    qp.set("limit", String(limit))
    const data = await this.get("/api/v1/holos/agent_tunnel/agents/list", qp)
    let parsed
    try {
      parsed = ClarusRestPort.WireAgentListData.parse(data)
    } catch {
      throw new Error("Clarus agent list response is malformed")
    }

    const lowerQuery = query.toLowerCase()
    const candidates: ClarusRestPort.UserCandidateDto[] = []
    const seenUsers = new Set<string>()

    for (const item of parsed.items) {
      if (!item.agent_id || !item.owner_id) continue
      if (item.agent_id.toLowerCase() === lowerQuery) {
        if (!seenUsers.has(item.owner_id)) {
          seenUsers.add(item.owner_id)
          candidates.push({ userId: item.owner_id, userName: item.owner_name, agentId: item.agent_id })
        }
      }
    }

    for (const item of parsed.items) {
      if (candidates.length >= MAX_USER_CANDIDATES) break
      if (!item.agent_id || !item.owner_id) continue
      if (seenUsers.has(item.owner_id)) continue
      if (item.agent_id.toLowerCase().includes(lowerQuery) || item.owner_name.toLowerCase().includes(lowerQuery)) {
        seenUsers.add(item.owner_id)
        candidates.push({ userId: item.owner_id, userName: item.owner_name, agentId: item.agent_id })
      }
    }

    candidates.sort((a, b) => {
      const nameCmp = a.userName.localeCompare(b.userName, undefined, { sensitivity: "base" })
      if (nameCmp !== 0) return nameCmp
      return a.agentId.localeCompare(b.agentId, undefined, { sensitivity: "base" })
    })

    if (candidates.length > MAX_USER_CANDIDATES) {
      candidates.length = MAX_USER_CANDIDATES
    }

    return { users: candidates }
  }

  private async get(pathname: string, query?: URLSearchParams): Promise<unknown> {
    const credential = await this.credentials()
    if (!credential) throw new Error("Clarus credentials are unavailable")
    ClarusIdSchema.parse(credential.agentId)
    if (!credential.agentSecret || credential.agentSecret.length > 4096) throw new Error("Clarus credential is invalid")
    const url = new URL(pathname, this.baseUrl)
    if (query) url.search = query.toString()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetcher(
        new Request(url, {
          method: "GET",
          redirect: "error",
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${credential.agentSecret}`,
            "X-Agent-Id": credential.agentId,
          },
        }),
      )
      if (response.url && new URL(response.url).origin !== this.baseUrl.origin)
        throw new Error("Clarus redirect changed origin")
      const body = await response.text()
      const parsed = parseResponseBody(body, this.maxResponseBytes)
      const envelope = ClarusRestPort.StandardResponse.parse(parsed)
      if (!response.ok || envelope.code !== 0) {
        throw new Error(redactMessage(response.status, envelope.code, envelope.message))
      }
      return envelope.data
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Clarus")) throw error
      throw new Error("Clarus REST request failed")
    } finally {
      clearTimeout(timer)
    }
  }
}
