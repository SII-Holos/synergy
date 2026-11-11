import { z } from "zod"
import { createHash } from "node:crypto"
import { OrganizationDesktop as Desktop } from "@ericsanchezok/synergy-organization-protocol"
import type { DesktopOrganizationAccounts } from "./accounts.js"
import type { DesktopOrganizationAuthorization } from "./authorization.js"
import type { DesktopMemberRuntimes } from "./member-runtimes.js"
import { DesktopOrganizationError as Failure } from "./error.js"

type Action = keyof Desktop.Bridge
const id = "[a-zA-Z0-9_-]+"
const routes: [string, RegExp][] = [
  ["GET", /^\/org\/v1\/(organization|accounts|projects|runtimes|resources|auth\/session)$/],
  ["GET", new RegExp(`^/org/v1/(projects|runtimes|resources|sessions)/${id}$`)],
  ["GET", new RegExp(`^/org/v1/projects/${id}/(members|member-candidates|sessions|resources)$`)],
  ["GET", new RegExp(`^/org/v1/sessions/${id}/(resources|share|sync/events|sync/search|sync/snapshot)$`)],
  ["GET", new RegExp(`^/org/v1/sessions/${id}/commands/${id}$`)],
  ["GET", new RegExp(`^/org/v1/commands/${id}$`)],
  ["GET", new RegExp(`^/org/v1/resources/${id}/grants/(account|project)$`)],
  ["POST", /^\/org\/v1\/(projects|invites|sessions|resources|organization\/transfer-owner|auth\/password)$/],
  ["POST", new RegExp(`^/org/v1/sessions/${id}/(commands|control|share)$`)],
  ["DELETE", new RegExp(`^/org/v1/sessions/${id}/share$`)],
  ["POST", new RegExp(`^/org/v1/accounts/${id}/reset$`)],
  ["POST", new RegExp(`^/org/v1/runtimes/${id}/revoke$`)],
  ["PATCH", new RegExp(`^/org/v1/(accounts|projects|resources)/${id}$`)],
  ["PUT", new RegExp(`^/org/v1/projects/${id}/members/${id}$`)],
  ["PUT", new RegExp(`^/org/v1/resources/${id}/grants/(account|project)/${id}$`)],
  ["PUT", new RegExp(`^/org/v1/sessions/${id}/resources$`)],
  ["GET", /^\/org\/v1\/knowledge(?:\/search)?$/],
  ["POST", /^\/org\/v1\/(knowledge|artifacts|publications\/uploads)$/],
  ["GET", new RegExp(`^/org/v1/(knowledge|artifacts)/${id}(?:/versions(?:/[1-9][0-9]*(?:/(?:files|reference))?)?)?$`)],
  ["DELETE", new RegExp(`^/org/v1/knowledge/${id}$`)],
  ["GET", new RegExp(`^/org/v1/projects/${id}/(knowledge/applied|artifacts)$`)],
  ["PUT", new RegExp(`^/org/v1/projects/${id}/knowledge/applied$`)],
  ["GET", new RegExp(`^/org/v1/sessions/${id}/knowledge$`)],
  ["PUT", new RegExp(`^/org/v1/sessions/${id}/knowledge$`)],
  ["GET", new RegExp(`^/org/v1/publications/uploads/${id}(?:/files)?$`)],
  ["PUT", new RegExp(`^/org/v1/publications/uploads/${id}/files$`)],
  ["POST", new RegExp(`^/org/v1/publications/uploads/${id}/seal$`)],
]
const binaryReadRoutes = [
  new RegExp(`^/org/v1/sessions/${id}/blobs/[a-f0-9]{64}/content$`),
  new RegExp(`^/org/v1/(knowledge|artifacts)/${id}/versions/[1-9][0-9]*/files/[a-f0-9]{64}/content$`),
]
const binaryWriteRoutes = [
  new RegExp(`^/org/v1/sessions/${id}/blobs/[a-f0-9]{64}$`),
  new RegExp(`^/org/v1/publications/uploads/${id}/files/[a-f0-9]{64}/chunks$`),
]

function parse<T>(schema: z.ZodType<T>, input: unknown) {
  const value = schema.safeParse(input)
  if (!value.success) throw new Failure("invalid_request")
  return value.data
}

function validateRequest(input: unknown): Desktop.Request {
  const value = parse(Desktop.Request, input)
  try {
    const url = new URL(value.path, "https://organization.invalid")
    if (
      url.origin !== "https://organization.invalid" ||
      url.pathname + url.search !== value.path ||
      url.hash ||
      !(
        routes.some(([method, pattern]) => method === value.method && pattern.test(url.pathname)) ||
        (value.method === "GET" && binaryReadRoutes.some((pattern) => pattern.test(url.pathname))) ||
        (value.method === "PUT" && binaryWriteRoutes.some((pattern) => pattern.test(url.pathname)))
      ) ||
      (value.range !== undefined && !binaryReadRoutes.some((pattern) => pattern.test(url.pathname))) ||
      (value.bodyBytes !== undefined &&
        (value.method !== "PUT" || !binaryWriteRoutes.some((pattern) => pattern.test(url.pathname))))
    )
      throw new Error()
    if (value.body !== undefined) {
      if (value.method === "GET" || Buffer.byteLength(value.body) > 65_536) throw new Error()
      JSON.parse(value.body)
    }
  } catch {
    throw new Failure("invalid_request")
  }
  return value
}

async function responseBody(response: Response, signal: AbortSignal): Promise<string> {
  if (response.status === 204) return ""
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
    throw new Failure("invalid_response")
  if (Number(response.headers.get("content-length")) > 2_097_152) throw new Failure("invalid_response")
  const reader = response.body?.getReader()
  if (!reader) throw new Failure("invalid_response")
  const chunks: Uint8Array[] = []
  let size = 0
  const cancel = () => {
    void reader.cancel().catch(() => {})
  }
  signal.addEventListener("abort", cancel, { once: true })
  try {
    for (;;) {
      if (signal.aborted) throw new Failure("cancelled")
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > 2_097_152) throw new Failure("invalid_response")
      chunks.push(chunk.value)
    }
    const body = Buffer.concat(chunks).toString("utf8")
    try {
      JSON.parse(body)
    } catch {
      throw new Failure("invalid_response")
    }
    return body
  } finally {
    signal.removeEventListener("abort", cancel)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

async function binaryResponse(response: Response, signal: AbortSignal, range?: string): Promise<Desktop.Response> {
  const contentType = response.headers.get("content-type") ?? "application/octet-stream"
  const contentRange = response.headers.get("content-range") ?? undefined
  const matched = contentRange?.match(/^bytes (\d+)-(\d+)\/(\d+)$/)
  if (range) {
    const [start, end] = range.slice(6).split("-").map(Number)
    if (
      response.status !== 206 ||
      !matched ||
      Number(matched[1]) !== start ||
      Number(matched[2]) !== Math.min(end!, Number(matched[3]) - 1)
    )
      throw new Failure("invalid_response")
  }
  if (Number(response.headers.get("content-length")) > Desktop.BinaryLimit) throw new Failure("invalid_response")
  const reader = response.body?.getReader()
  if (!reader) throw new Failure("invalid_response")
  const cancel = () => {
    void reader.cancel().catch(() => {})
  }
  signal.addEventListener("abort", cancel, { once: true })
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      if (signal.aborted) throw new Failure("cancelled")
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > Desktop.BinaryLimit) throw new Failure("invalid_response")
      chunks.push(chunk.value)
    }
    if (matched && size !== Number(matched[2]) - Number(matched[1]) + 1) throw new Failure("invalid_response")
    const bodyBytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bodyBytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    const result = Desktop.Response.safeParse({
      status: response.status,
      bodyBytes,
      contentType,
      ...(contentRange ? { contentRange } : {}),
    })
    if (!result.success) throw new Failure("invalid_response")
    return result.data
  } finally {
    signal.removeEventListener("abort", cancel)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export class DesktopOrganizationIPC<Event = unknown> {
  private generation = 0
  private disposed = false
  private requests = new Map<string, { controller: AbortController; connectionID?: string }>()

  constructor(
    private options: {
      accounts: DesktopOrganizationAccounts
      authorization: DesktopOrganizationAuthorization
      members?: DesktopMemberRuntimes
      fetch?: typeof fetch
      saveFile?: (
        fileName: string,
        write: (append: (chunk: Uint8Array) => Promise<void>) => Promise<number>,
        signal: AbortSignal,
      ) => Promise<Desktop.DownloadResult>
      trusted(event: Event): boolean
    },
  ) {}

  async handle(event: Event, action: Action, input: unknown): Promise<Desktop.Result<unknown>> {
    if (!this.options.trusted(event)) return { ok: false, error: { code: "untrusted_sender" } }
    const generation = this.generation
    const current = () => !this.disposed && generation === this.generation && this.options.trusted(event)
    try {
      if (!current()) throw new Failure("cancelled")
      const value = await this.dispatch(action, input, current)
      if (!current()) throw new Failure("cancelled")
      return { ok: true, value }
    } catch (error) {
      return {
        ok: false,
        error: { code: !current() ? "cancelled" : error instanceof Failure ? error.code : "unavailable" },
      }
    }
  }

  invalidate() {
    this.generation++
    for (const request of this.requests.values()) request.controller.abort()
    this.requests.clear()
    this.options.authorization.cancel()
  }

  dispose() {
    this.disposed = true
    this.invalidate()
    this.options.authorization.dispose()
    this.options.accounts.dispose()
  }

  settle() {
    return this.options.accounts.settle()
  }

  private async dispatch(action: Action, input: unknown, current: () => boolean) {
    switch (action) {
      case "list":
        parse(z.undefined(), input)
        return this.options.accounts.list()
      case "connect": {
        const request = parse(Desktop.Start, input)
        return this.run(request.requestID, undefined, (signal) =>
          this.options.authorization.authorize(request.target, { signal, current }),
        )
      }
      case "request": {
        const request = validateRequest(input)
        return this.run(request.requestID, request.connectionID, async (signal) => {
          const access = await this.options.accounts.access(request.connectionID)
          if (!current() || signal.aborted) throw new Failure("cancelled")
          const headers = new Headers({ authorization: `Bearer ${access.accessToken}`, accept: "application/json" })
          if (request.body !== undefined) headers.set("content-type", "application/json")
          if (request.bodyBytes !== undefined) headers.set("content-type", "application/octet-stream")
          if (request.range !== undefined) headers.set("range", request.range)
          const response = await (this.options.fetch ?? globalThis.fetch)(
            new Request(`${access.connection.issuer}${request.path}`, {
              method: request.method,
              body: request.bodyBytes !== undefined ? new Uint8Array(request.bodyBytes) : request.body,
              headers,
              signal,
              redirect: "error",
              credentials: "omit",
              referrerPolicy: "no-referrer",
            }),
          )
          if (!current() || signal.aborted) {
            await response.body?.cancel().catch(() => {})
            throw new Failure("cancelled")
          }
          if (response.redirected || response.status < 200 || (response.status >= 300 && response.status < 400)) {
            await response.body?.cancel().catch(() => {})
            throw new Failure("invalid_response")
          }
          try {
            if (
              request.method === "GET" &&
              response.ok &&
              binaryReadRoutes.some((pattern) => pattern.test(new URL(request.path, access.connection.issuer).pathname))
            )
              return await binaryResponse(response, signal, request.range)
            return { status: response.status, body: await responseBody(response, signal) } satisfies Desktop.Response
          } catch (error) {
            await response.body?.cancel().catch(() => {})
            throw error
          }
        })
      }
      case "cancel": {
        const request = parse(Desktop.Cancel, input)
        this.requests.get(request.requestID)?.controller.abort()
        return
      }
      case "signOut": {
        const { connectionID } = parse(Desktop.Account, input)
        for (const request of this.requests.values())
          if (request.connectionID === connectionID) request.controller.abort()
        const connection = (await this.options.accounts.list()).find((connection) => connection.id === connectionID)
        if (!current()) throw new Failure("cancelled")
        if (connection) this.options.authorization.cancel(connection)
        return this.options.accounts.signOut(connectionID)
      }
      case "memberStatus": {
        const { connectionID } = parse(Desktop.Account, input)
        if (!this.options.members) throw new Failure("unavailable")
        return this.options.members.status(connectionID)
      }
      case "startMember": {
        const request = parse(Desktop.MemberStart, input)
        if (!this.options.members) throw new Failure("unavailable")
        return this.run(request.requestID, request.connectionID, (signal) =>
          this.options.members!.start(request.connectionID, signal),
        )
      }
      case "download": {
        const request = parse(Desktop.Download, input)
        validateRequest({
          requestID: request.requestID,
          connectionID: request.connectionID,
          method: "GET",
          path: request.path,
        })
        if (
          !binaryReadRoutes.some((pattern) =>
            pattern.test(new URL(request.path, "https://organization.invalid").pathname),
          )
        )
          throw new Failure("invalid_request")
        if (!this.options.saveFile) throw new Failure("unavailable")
        return this.run(request.requestID, request.connectionID, (signal) =>
          this.options.saveFile!(
            request.fileName,
            async (append) => {
              const access = await this.options.accounts.access(request.connectionID)
              if (!current() || signal.aborted) throw new Failure("cancelled")
              const response = await (this.options.fetch ?? globalThis.fetch)(
                new Request(`${access.connection.issuer}${request.path}`, {
                  headers: { authorization: `Bearer ${access.accessToken}` },
                  signal,
                  redirect: "error",
                  credentials: "omit",
                  referrerPolicy: "no-referrer",
                }),
              )
              if (!response.ok || response.redirected || !response.body) {
                await response.body?.cancel().catch(() => {})
                throw new Failure(response.status === 401 ? "reauthorization_required" : "invalid_response")
              }
              const reader = response.body.getReader()
              const cancel = () => {
                void reader.cancel().catch(() => {})
              }
              signal.addEventListener("abort", cancel, { once: true })
              const digest = createHash("sha256")
              let size = 0
              try {
                for (;;) {
                  if (!current() || signal.aborted) throw new Failure("cancelled")
                  const next = await reader.read()
                  if (next.done) break
                  size += next.value.byteLength
                  if (size > request.bytes) throw new Failure("invalid_response")
                  digest.update(next.value)
                  await append(next.value)
                }
                if (!current() || signal.aborted) throw new Failure("cancelled")
                if (size !== request.bytes || digest.digest("hex") !== request.sha256)
                  throw new Failure("invalid_response")
                return size
              } finally {
                signal.removeEventListener("abort", cancel)
                await reader.cancel().catch(() => {})
                reader.releaseLock()
              }
            },
            signal,
          ),
        )
      }
    }
  }

  private async run<T>(
    requestID: string,
    connectionID: string | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
  ) {
    if (this.requests.has(requestID)) throw new Failure("request_in_progress")
    if (this.requests.size >= 64) throw new Failure("unavailable")
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(300_000)])
    const request = { controller, connectionID }
    this.requests.set(requestID, request)
    let cancel!: () => void
    const cancelled = new Promise<never>((_, reject) => {
      cancel = () => reject(new Failure("cancelled"))
    })
    signal.addEventListener("abort", cancel, { once: true })
    try {
      return await Promise.race([operation(signal), cancelled])
    } finally {
      signal.removeEventListener("abort", cancel)
      if (this.requests.get(requestID) === request) this.requests.delete(requestID)
    }
  }
}

export function registerOrganizationIPC<Event>(
  host: {
    handle(channel: string, listener: (event: Event, input: unknown) => unknown): void
  },
  owner: DesktopOrganizationIPC<Event>,
) {
  for (const action of [
    "list",
    "connect",
    "request",
    "cancel",
    "signOut",
    "memberStatus",
    "startMember",
    "download",
  ] as const)
    host.handle(`desktop.organization.${action}`, (event, input) => owner.handle(event, action, input))
}
