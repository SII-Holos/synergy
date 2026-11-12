import { z } from "zod"
import { createHash } from "node:crypto"
import {
  OrganizationDesktop as Desktop,
  OrganizationLocalProjectProtocol as LocalProject,
  OrganizationIdentity as Identity,
  OrganizationRuntimeProtocol as Runtime,
  OrganizationProtocol as Protocol,
  OrganizationReadProtocol as Read,
  OrganizationSessionProtocol as Session,
} from "@ericsanchezok/synergy-organization-protocol"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"
import { createOrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import type { DesktopOrganizationAccounts } from "./accounts.js"
import type { DesktopOrganizationAuthorization } from "./authorization.js"
import type { DesktopMemberRuntimes } from "./member-runtimes.js"
import { DesktopOrganizationError as Failure } from "./error.js"
import { downloadOrganizationAttachment, downloadOrganizationContent } from "./content-download.js"
import { downloadIdleDeadline } from "./transfer-deadline.js"
import { DesktopOrganizationCommandStream, type DesktopCommandLease } from "./command-stream.js"
import { DesktopOrganizationNotifications } from "./notification-stream.js"

type Action = keyof Desktop.Bridge | "notificationAck"
class NativeReadFailure extends Error {
  constructor(readonly kind: "not_found" | "revision_conflict" | "binding_changed") {
    super(kind)
  }
}
const id = "[a-zA-Z0-9_-]+"
const routes: [string, RegExp][] = [
  ["GET", /^\/org\/v1\/(organization|accounts|invites|projects|runtimes|resources|auth\/session)$/],
  ["GET", new RegExp(`^/org/v1/(projects|runtimes|resources|sessions)/${id}$`)],
  ["GET", new RegExp(`^/org/v1/projects/${id}/(members|member-candidates|sessions|resources)$`)],
  ["GET", new RegExp(`^/org/v1/sessions/${id}/(resources|share|sync/events|sync/search|sync/snapshot|sync/tasks)$`)],
  ["GET", new RegExp(`^/org/v1/sessions/${id}/sync/messages(?:/${id}/parts)?$`)],
  ["GET", new RegExp(`^/org/v1/runtimes/${id}/connection$`)],
  ["GET", new RegExp(`^/org/v1/sessions/${id}/commands/${id}$`)],
  ["GET", new RegExp(`^/org/v1/commands/${id}$`)],
  ["GET", new RegExp(`^/org/v1/resources/${id}/grants/(account|project)$`)],
  ["POST", /^\/org\/v1\/(projects|invites|sessions|resources|organization\/(transfer-owner|leave)|auth\/password)$/],
  ["POST", new RegExp(`^/org/v1/invites/${id}/revoke$`)],
  ["POST", new RegExp(`^/org/v1/sessions/${id}/(commands|control|read)$`)],
  ["POST", new RegExp(`^/org/v1/sessions/${id}/interactions(?:/reply)?$`)],
  ["GET", /^\/org\/v1\/api-tokens$/],
  ["POST", /^\/org\/v1\/api-tokens$/],
  ["POST", new RegExp(`^/org/v1/api-tokens/${id}/revoke$`)],
  ["DELETE", new RegExp(`^/org/v1/sessions/${id}/share$`)],
  ["POST", new RegExp(`^/org/v1/accounts/${id}/reset$`)],
  ["POST", new RegExp(`^/org/v1/runtimes/${id}/revoke$`)],
  ["PATCH", new RegExp(`^/org/v1/(accounts|projects|resources)/${id}$`)],
  ["PUT", new RegExp(`^/org/v1/projects/${id}/members/${id}$`)],
  ["PUT", new RegExp(`^/org/v1/resources/${id}/grants/(account|project)/${id}$`)],
  ["PUT", new RegExp(`^/org/v1/sessions/${id}/(resources|share)$`)],
  ["GET", /^\/org\/v1\/knowledge(?:\/search)?$/],
  ["POST", /^\/org\/v1\/(knowledge|artifacts|publications\/uploads)$/],
  ["POST", /^\/org\/v1\/knowledge\/publication-receipts$/],
  ["POST", /^\/org\/v1\/artifacts\/publication-receipts$/],
  ["GET", new RegExp(`^/org/v1/(knowledge|artifacts)/${id}(?:/versions(?:/[1-9][0-9]*(?:/(?:files|reference))?)?)?$`)],
  ["DELETE", new RegExp(`^/org/v1/knowledge/${id}$`)],
  ["GET", new RegExp(`^/org/v1/projects/${id}/artifacts$`)],
  ["GET", new RegExp(`^/org/v1/sessions/${id}/knowledge/status$`)],
  ["GET", new RegExp(`^/org/v1/projects/${id}/knowledge/applied/releases$`)],
  ["POST", new RegExp(`^/org/v1/projects/${id}/knowledge/applied/references$`)],
  ["GET", new RegExp(`^/org/v1/sessions/${id}/knowledge/releases$`)],
  ["POST", new RegExp(`^/org/v1/sessions/${id}/knowledge/references$`)],
  ["POST", /^\/org\/v1\/knowledge\/selection-updates$/],
  ["GET", new RegExp(`^/org/v1/knowledge/selection-updates/${id}$`)],
  ["POST", new RegExp(`^/org/v1/knowledge/selection-updates/${id}/(pages|commit)$`)],
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
      if (value.method === "GET" || Buffer.byteLength(value.body) > Desktop.ControlLimit) throw new Error()
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
  private commandStreams: DesktopOrganizationCommandStream
  private notifications: DesktopOrganizationNotifications

  constructor(
    private options: {
      accounts: DesktopOrganizationAccounts
      authorization: DesktopOrganizationAuthorization
      members?: Pick<DesktopMemberRuntimes, "start" | "status" | "running">
      fetch?: typeof fetch
      requestTimeoutMs?: number
      transferIdleMs?: number
      emitNotification?(event: Event, value: Desktop.NotificationEvent): void
      chooseDirectory?: () => Promise<string | undefined>
      saveFile?: (
        fileName: string,
        write: (append: (chunk: Uint8Array) => Promise<void>) => Promise<number>,
        signal: AbortSignal,
      ) => Promise<Desktop.DownloadResult>
      trusted(event: Event): boolean
    },
  ) {
    this.notifications = new DesktopOrganizationNotifications({
      reserve: (requestID, connectionID, current) => this.reserve(requestID, connectionID, "transfer", current),
      access: (connectionID) => this.options.accounts.access(connectionID),
      fetch: this.options.fetch,
    })
    this.commandStreams = new DesktopOrganizationCommandStream({
      reserve: (requestID, connectionID, current) => this.reserve(requestID, connectionID, "request", current),
      connection: async (connectionID) => (await this.options.accounts.access(connectionID)).connection,
      submit: async (connectionID, command, signal, current) => {
        const access = await this.options.accounts.access(connectionID)
        if (!current() || signal.aborted) throw new Failure("cancelled")
        const client = createOrganizationClient({
          baseUrl: access.connection.issuer,
          fetch: this.jsonTransport(access.connection.issuer, signal, current),
          headers: { authorization: `Bearer ${access.accessToken}` },
          credentials: "omit",
          redirect: "error",
        })
        const result =
          "input" in command
            ? await client.orgCommands.input(
                { sessionID: command.sessionID, orgCommandInputRequest: command },
                { signal },
              )
            : await client.orgSessionInteractions.reply(
                { sessionID: command.sessionID, orgCommandDecisionRequest: command },
                { signal },
              )
        if (!current() || signal.aborted) throw new Failure("cancelled")
        const body = JSON.stringify(result.data ?? result.error)
        if (body === undefined) throw new Failure("invalid_response")
        return { status: result.response.status, body }
      },
    })
  }

  async handle(event: Event, action: Action, input: unknown): Promise<Desktop.Result<unknown>> {
    if (!this.options.trusted(event)) return { ok: false, error: { code: "untrusted_sender" } }
    const generation = this.generation
    const current = () => !this.disposed && generation === this.generation && this.options.trusted(event)
    try {
      if (!current()) throw new Failure("cancelled")
      const value =
        action === "notificationStart"
          ? await this.startNotifications(event, input, current)
          : await this.dispatch(action, input, current)
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

  private async startNotifications(event: Event, input: unknown, current: () => boolean) {
    const emit = this.options.emitNotification
    if (!emit) throw new Failure("unavailable")
    await this.notifications.start(input, current, (value) => {
      if (!current()) throw new Failure("cancelled")
      emit(event, value)
    })
  }

  private async dispatch(action: Action, input: unknown, current: () => boolean) {
    switch (action) {
      case "notificationStop":
        return this.notifications.stop(input, current)
      case "notificationAck":
        return this.notifications.ack(input, current)
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
      case "commandStream":
        return this.commandStreams.handle(input, current)
      case "cancel": {
        const request = parse(Desktop.Cancel, input)
        this.requests.get(request.requestID)?.controller.abort()
        return
      }
      case "signOut": {
        const request = parse(Desktop.SignOut, input)
        if (!current()) throw new Failure("cancelled")
        const connection = await this.options.accounts.signOut(request)
        if (request.phase === "prepare" && connection.state === "sign_out_pending") {
          for (const pending of this.requests.values())
            if (pending.connectionID === connection.id) pending.controller.abort()
          this.options.authorization.cancel(connection)
        }
        return connection
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
        return this.run(
          request.requestID,
          request.connectionID,
          (signal) =>
            this.options.saveFile!(
              request.fileName,
              async (append) => {
                const owner = this.requests.get(request.requestID)
                const deadline = downloadIdleDeadline(signal, this.options.transferIdleMs, () =>
                  owner?.controller.abort(),
                )
                const transferSignal = deadline.signal
                try {
                  const access = await this.options.accounts.access(request.connectionID)
                  if (!current() || transferSignal.aborted) throw new Failure("cancelled")
                  const response = await (this.options.fetch ?? globalThis.fetch)(
                    new Request(`${access.connection.issuer}${request.path}`, {
                      headers: { authorization: `Bearer ${access.accessToken}` },
                      signal: transferSignal,
                      redirect: "error",
                      credentials: "omit",
                      referrerPolicy: "no-referrer",
                    }),
                  )
                  const length = response.headers.get("content-length")
                  if (
                    response.status !== 200 ||
                    response.redirected ||
                    (!response.body && request.bytes !== 0) ||
                    (length !== null && (!/^\d+$/.test(length) || Number(length) !== request.bytes))
                  ) {
                    await response.body?.cancel().catch(() => {})
                    throw new Failure(response.status === 401 ? "reauthorization_required" : "invalid_response")
                  }
                  const reader = response.body?.getReader()
                  const cancel = () => {
                    void reader?.cancel().catch(() => {})
                  }
                  transferSignal.addEventListener("abort", cancel, { once: true })
                  const digest = createHash("sha256")
                  let size = 0
                  try {
                    while (reader) {
                      if (!current() || transferSignal.aborted) throw new Failure("cancelled")
                      const next = await reader.read()
                      if (next.done) break
                      if (!next.value.byteLength) throw new Failure("invalid_response")
                      size += next.value.byteLength
                      if (size > request.bytes) throw new Failure("invalid_response")
                      digest.update(next.value)
                      await append(next.value)
                      deadline.progress(next.value.byteLength)
                    }
                    if (!current() || transferSignal.aborted) throw new Failure("cancelled")
                    if (size !== request.bytes || digest.digest("hex") !== request.sha256)
                      throw new Failure("invalid_response")
                    return size
                  } finally {
                    transferSignal.removeEventListener("abort", cancel)
                    await reader?.cancel().catch(() => {})
                    reader?.releaseLock()
                  }
                } finally {
                  deadline.dispose()
                }
              },
              signal,
            ),
          "transfer",
        )
      }
      case "projectBinding":
      case "bindProject": {
        const request =
          action === "projectBinding" ? parse(Desktop.ProjectBinding, input) : parse(Desktop.ProjectBind, input)
        return this.run(
          request.requestID,
          request.connectionID,
          async (signal): Promise<Desktop.ProjectBindingOutcome> => {
            let context = await this.memberProject(request.connectionID, request.projectID, signal, current)
            const read = async () => {
              const result = await context.client.orgLocalProject.get({ projectID: request.projectID }, { signal })
              context.assertCurrent()
              if (result.error) this.projectError(result.error)
              const value = LocalProject.Summary.safeParse(result.data)
              if (!value.success) throw new Failure("invalid_response")
              if (value.data.projectID !== request.projectID) throw new Failure("identity_changed")
              return value.data
            }
            const summary = await read()
            if (!("expectedRevision" in request)) return { kind: "ready", summary }
            if (summary.revision !== request.expectedRevision) return { kind: "revision_conflict", current: summary }
            if (!this.options.chooseDirectory) throw new Failure("unavailable")
            const directory = await this.options.chooseDirectory()
            context.assertCurrent()
            if (directory === undefined) throw new Failure("cancelled")
            const checked = await this.memberProject(request.connectionID, request.projectID, signal, current)
            context.assertCurrent()
            context = checked
            const binding = {
              requestID: request.requestID,
              expectedRevision: request.expectedRevision,
              directory,
            }
            if (Buffer.byteLength(JSON.stringify(binding)) > 64 * 1024) throw new Failure("invalid_request")
            const result = await context.client.orgLocalProject.bind(
              {
                projectID: request.projectID,
                orgLocalProjectBind: binding,
              },
              { signal },
            )
            context.assertCurrent()
            if (result.error) {
              const error = Protocol.Error.safeParse(result.error)
              if (error.success && error.data.code === "REVISION_CONFLICT")
                return { kind: "revision_conflict", current: await read() }
              this.projectError(result.error)
            }
            const returned = LocalProject.Summary.safeParse(result.data)
            if (!returned.success || returned.data.projectID !== request.projectID)
              throw new Failure("invalid_response")
            return { kind: "ready", summary: await read() }
          },
        )
      }
      case "memberRequest": {
        const request = parse(Desktop.MemberRequest, input)
        return this.run(request.requestID, request.connectionID, (signal) =>
          this.readMember(request.connectionID, request.query, signal, current),
        )
      }
      case "downloadContent":
      case "downloadAttachment": {
        const download =
          action === "downloadContent"
            ? { kind: "content" as const, request: parse(Desktop.ContentDownload, input) }
            : { kind: "attachment" as const, request: parse(Desktop.AttachmentDownload, input) }
        const request = download.request
        if (!this.options.saveFile) throw new Failure("unavailable")
        return this.run(
          request.requestID,
          request.connectionID,
          async (signal) => {
            const owner = this.requests.get(request.requestID)
            const local = this.options.members
              ?.running()
              .find(
                (member) =>
                  member.connectionID === request.connectionID && member.runtimeID === request.binding.driverRuntimeID,
              )
            const read = async (query: Read.Query): Promise<Read.Result> => {
              const deadline = downloadIdleDeadline(signal, this.options.transferIdleMs, () =>
                owner?.controller.abort(),
              )
              const readSignal = deadline.signal
              try {
                if (!current() || readSignal.aborted) throw new Failure("cancelled")
                if (local) {
                  const now = this.options.members
                    ?.running()
                    .find((member) => member.connectionID === request.connectionID)
                  if (
                    !now ||
                    now.runtimeID !== local.runtimeID ||
                    now.connection.url !== local.connection.url ||
                    new Headers(now.connection.headers).get("authorization") !==
                      new Headers(local.connection.headers).get("authorization")
                  )
                    throw new NativeReadFailure("binding_changed")
                  const result = await this.readMember(request.connectionID, query, readSignal, current)
                  if (result.kind !== "result") throw new NativeReadFailure(result.kind)
                  return result.result
                }
                const access = await this.options.accounts.access(request.connectionID)
                if (!current() || readSignal.aborted) throw new Failure("cancelled")
                if (
                  access.connection.orgID !== request.binding.orgID ||
                  access.connection.account.accountID !== request.binding.creatorID
                )
                  throw new Failure("permission_denied")
                const client = createOrganizationClient({
                  baseUrl: access.connection.issuer,
                  fetch: this.jsonTransport(access.connection.issuer, readSignal, current),
                  headers: { authorization: `Bearer ${access.accessToken}` },
                  credentials: "omit",
                  redirect: "error",
                })
                const response = await client.orgSessionRead.read(
                  { sessionID: query.rootSessionID, orgPrivateReadQuery: query },
                  { signal: readSignal },
                )
                if (!current() || readSignal.aborted) throw new Failure("cancelled")
                if (response.error) this.readError(response.error)
                const result = Read.Result.safeParse(response.data)
                if (!result.success || !Read.matches(query, result.data, request.binding))
                  throw new Failure("invalid_response")
                return result.data
              } finally {
                deadline.dispose()
              }
            }
            const options = {
              signal,
              read,
              save: (name: string, write: (append: (chunk: Uint8Array) => Promise<void>) => Promise<number>) =>
                this.options.saveFile!(name, write, signal),
            }
            return download.kind === "content"
              ? downloadOrganizationContent(download.request, options)
              : downloadOrganizationAttachment(download.request, options)
          },
          "transfer",
        )
      }
    }
  }

  private projectError(value: unknown): never {
    const error = Protocol.Error.safeParse(value)
    if (!error.success) throw new Failure("invalid_response")
    throw new Failure(
      error.data.code === "AUTHENTICATION_REQUIRED"
        ? "reauthorization_required"
        : error.data.code === "PERMISSION_DENIED"
          ? "permission_denied"
          : "unavailable",
    )
  }

  private readError(value: unknown): never {
    const error = Protocol.Error.safeParse(value)
    if (!error.success) throw new Failure("invalid_response")
    if (error.data.code === "NOT_FOUND") throw new NativeReadFailure("not_found")
    if (error.data.code === "REVISION_CONFLICT") throw new NativeReadFailure("revision_conflict")
    if (error.data.code === "STALE_BINDING" || error.data.code === "STALE_CONNECTION")
      throw new NativeReadFailure("binding_changed")
    this.projectError(error.data)
  }

  private async readMember(
    connectionID: string,
    query: Read.Query,
    signal: AbortSignal,
    current: () => boolean,
  ): Promise<Desktop.MemberReadOutcome> {
    try {
      const running = this.options.members?.running().find((member) => member.connectionID === connectionID)
      if (!running) throw new Failure("unavailable")
      const live = () => {
        if (!current() || signal.aborted) throw new Failure("cancelled")
        const now = this.options.members?.running().find((member) => member.connectionID === connectionID)
        if (
          !now ||
          now.runtimeID !== running.runtimeID ||
          now.connection.url !== running.connection.url ||
          new Headers(now.connection.headers).get("authorization") !==
            new Headers(running.connection.headers).get("authorization")
        )
          throw new NativeReadFailure("binding_changed")
      }
      const authorize = async () => {
        const access = await this.options.accounts.access(connectionID)
        live()
        const client = createOrganizationClient({
          baseUrl: access.connection.issuer,
          fetch: this.jsonTransport(access.connection.issuer, signal, current),
          headers: { authorization: `Bearer ${access.accessToken}` },
          credentials: "omit",
          redirect: "error",
        })
        const [directoryResult, runtimeResult] = await Promise.all([
          client.orgSessions.get({ sessionID: query.rootSessionID }, { signal }),
          client.orgRuntime.get({ runtimeID: running.runtimeID }, { signal }),
        ])
        live()
        if (directoryResult.error) this.readError(directoryResult.error)
        if (runtimeResult.error) this.readError(runtimeResult.error)
        const directory = Session.View.safeParse(directoryResult.data)
        const runtime = Runtime.Registration.safeParse(runtimeResult.data)
        if (!directory.success || !runtime.success) throw new Failure("invalid_response")
        if (directory.data.sessionID !== query.rootSessionID) throw new Failure("invalid_response")
        if (directory.data.creatorID !== access.connection.account.accountID || !directory.data.permissions.read)
          throw new Failure("permission_denied")
        if (directory.data.driverRuntimeID !== running.runtimeID) throw new NativeReadFailure("binding_changed")
        if (
          runtime.data.runtimeID !== running.runtimeID ||
          runtime.data.orgID !== access.connection.orgID ||
          runtime.data.deploymentIncarnation !== access.connection.deploymentIncarnation ||
          runtime.data.runtimeKind !== "member" ||
          runtime.data.accountID !== access.connection.account.accountID
        )
          throw new Failure("identity_changed")
        if (runtime.data.state !== "active") throw new Failure("permission_denied")
        return Protocol.SessionBinding.parse({
          schemaVersion: 1,
          orgID: access.connection.orgID,
          projectID: directory.data.projectID,
          creatorID: directory.data.creatorID,
          driverRuntimeID: directory.data.driverRuntimeID,
          bindingEpoch: directory.data.bindingEpoch,
        })
      }
      const binding = await authorize()
      const client = createSynergyClient({
        baseUrl: running.connection.url,
        fetch: this.jsonTransport(running.connection.url, signal, current),
        headers: running.connection.headers,
        credentials: "omit",
        redirect: "error",
      })
      const response = await client.orgLocalSession.read({ orgPrivateReadQuery: query }, { signal })
      live()
      if (response.error) this.readError(response.error)
      const result = Read.Result.safeParse(response.data)
      if (!result.success) throw new Failure("invalid_response")
      if (JSON.stringify(result.data.binding) !== JSON.stringify(binding))
        throw new NativeReadFailure("binding_changed")
      if (!Read.matches(query, result.data, binding)) throw new Failure("invalid_response")
      const checked = await authorize()
      if (JSON.stringify(checked) !== JSON.stringify(binding)) throw new NativeReadFailure("binding_changed")
      return { kind: "result", result: result.data }
    } catch (error) {
      if (error instanceof NativeReadFailure) return { kind: error.kind }
      throw error
    }
  }

  private jsonTransport(baseUrl: string, signal: AbortSignal, current: () => boolean) {
    const origin = new URL(baseUrl).origin
    return Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (!current() || signal.aborted) throw new Failure("cancelled")
        const request = new Request(input, init)
        if (new URL(request.url).origin !== origin) throw new Failure("invalid_request")
        const response = await (this.options.fetch ?? globalThis.fetch)(request)
        if (!current() || signal.aborted) {
          await response.body?.cancel().catch(() => {})
          throw new Failure("cancelled")
        }
        if (response.redirected || (response.status >= 300 && response.status < 400)) {
          await response.body?.cancel().catch(() => {})
          throw new Failure("invalid_response")
        }
        const body = await responseBody(response, signal)
        if (!current() || signal.aborted) throw new Failure("cancelled")
        return new Response(response.status === 204 ? null : body, {
          status: response.status,
          headers: response.headers,
        })
      },
      { preconnect() {} },
    )
  }

  private async memberProject(connectionID: string, projectID: string, signal: AbortSignal, current: () => boolean) {
    const access = await this.options.accounts.access(connectionID)
    if (!current() || signal.aborted) throw new Failure("cancelled")
    const running = this.options.members?.running().find((member) => member.connectionID === connectionID)
    if (!running) throw new Failure("unavailable")
    const assertCurrent = () => {
      if (!current() || signal.aborted) throw new Failure("cancelled")
      const now = this.options.members?.running().find((member) => member.connectionID === connectionID)
      if (
        !now ||
        now.runtimeID !== running.runtimeID ||
        now.connection.url !== running.connection.url ||
        new Headers(now.connection.headers).get("authorization") !==
          new Headers(running.connection.headers).get("authorization")
      )
        throw new Failure("identity_changed")
    }
    const client = createOrganizationClient({
      baseUrl: access.connection.issuer,
      fetch: this.jsonTransport(access.connection.issuer, signal, current),
      headers: { authorization: `Bearer ${access.accessToken}` },
      credentials: "omit",
      redirect: "error",
    })
    const [projectResult, runtimeResult] = await Promise.all([
      client.orgProjects.get({ projectID }, { signal }),
      client.orgRuntime.get({ runtimeID: running.runtimeID }, { signal }),
    ])
    assertCurrent()
    if (projectResult.error) this.projectError(projectResult.error)
    if (runtimeResult.error) this.projectError(runtimeResult.error)
    const project = Identity.ProjectView.safeParse(projectResult.data)
    const runtime = Runtime.Registration.safeParse(runtimeResult.data)
    if (!project.success || !runtime.success) throw new Failure("invalid_response")
    if (
      project.data.projectID !== projectID ||
      project.data.orgID !== access.connection.orgID ||
      runtime.data.runtimeID !== running.runtimeID ||
      runtime.data.orgID !== access.connection.orgID ||
      runtime.data.deploymentIncarnation !== access.connection.deploymentIncarnation ||
      runtime.data.runtimeKind !== "member" ||
      runtime.data.accountID !== access.connection.account.accountID
    )
      throw new Failure("identity_changed")
    if (!project.data.permissions.execute || runtime.data.state !== "active") throw new Failure("permission_denied")
    return {
      assertCurrent,
      client: createSynergyClient({
        baseUrl: running.connection.url,
        fetch: this.jsonTransport(running.connection.url, signal, current),
        headers: running.connection.headers,
        credentials: "omit",
        redirect: "error",
      }),
    }
  }

  private reserve(
    requestID: string,
    connectionID: string | undefined,
    lifetime: "request" | "transfer" = "request",
    current: () => boolean = () => !this.disposed,
  ): DesktopCommandLease {
    if (this.requests.has(requestID)) throw new Failure("request_in_progress")
    if (this.requests.size >= 64) throw new Failure("unavailable")
    const controller = new AbortController()
    const signal =
      lifetime === "transfer"
        ? controller.signal
        : AbortSignal.any([controller.signal, AbortSignal.timeout(this.options.requestTimeoutMs ?? 300_000)])
    const request = { controller, connectionID }
    this.requests.set(requestID, request)
    return {
      signal,
      current: () => current() && this.requests.get(requestID) === request && !signal.aborted,
      abort: () => controller.abort(),
      release: () => {
        if (this.requests.get(requestID) === request) this.requests.delete(requestID)
      },
    }
  }

  private async run<T>(
    requestID: string,
    connectionID: string | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
    lifetime: "request" | "transfer" = "request",
  ) {
    const lease = this.reserve(requestID, connectionID, lifetime)
    const signal = lease.signal
    let cancel!: () => void
    const cancelled = new Promise<never>((_, reject) => {
      cancel = () => reject(new Failure("cancelled"))
    })
    signal.addEventListener("abort", cancel, { once: true })
    try {
      return await Promise.race([operation(signal), cancelled])
    } finally {
      signal.removeEventListener("abort", cancel)
      lease.release()
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
    "commandStream",
    "notificationStart",
    "notificationStop",
    "notificationAck",
    "cancel",
    "signOut",
    "memberStatus",
    "startMember",
    "download",
    "projectBinding",
    "bindProject",
    "memberRequest",
    "downloadContent",
    "downloadAttachment",
  ] as const)
    host.handle(`desktop.organization.${action}`, (event, input) => owner.handle(event, action, input))
}
