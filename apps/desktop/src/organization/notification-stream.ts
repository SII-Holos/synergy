import {
  OrganizationDesktop as Desktop,
  OrganizationNotificationProtocol as Notification,
} from "@ericsanchezok/synergy-organization-protocol"
import { createOrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import { DesktopOrganizationError as Failure } from "./error.js"
import type { DesktopCommandLease } from "./command-stream.js"

type Access = { connection: Desktop.Connection; accessToken: string }
function completion() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((done, failed) => {
    resolve = done
    reject = failed
  })
  return { promise, resolve, reject }
}
type Options = {
  reserve(requestID: string, connectionID: string, current: () => boolean): DesktopCommandLease
  access(connectionID: string): Promise<Access>
  fetch?: typeof fetch
  idleMs?: number
  ackMs?: number
}
type Pending = {
  request: Desktop.NotificationStart
  lease: DesktopCommandLease
  emit(value: Desktop.NotificationEvent): void
  current(): boolean
  ready: ReturnType<typeof completion>
  cancel(): void
  idle?: ReturnType<typeof setTimeout>
  ack?: {
    streamID: string
    sequence: number
    resolve(): void
    reject(error: unknown): void
    timer: ReturnType<typeof setTimeout>
  }
}
export class DesktopOrganizationNotifications {
  private options: Options
  private pending = new Map<string, Pending>()
  constructor(input: Options) {
    this.options = { ...input }
  }

  private assert(value: Pending) {
    if (
      this.pending.get(value.request.requestID) !== value ||
      !value.current() ||
      !value.lease.current() ||
      value.lease.signal.aborted
    )
      throw new Failure("cancelled")
  }
  private end(value: Pending, code: Desktop.ErrorCode) {
    if (this.pending.get(value.request.requestID) !== value) return
    const notify = value.current() && value.lease.current() && !value.lease.signal.aborted
    this.pending.delete(value.request.requestID)
    clearTimeout(value.idle)
    value.lease.signal.removeEventListener("abort", value.cancel)
    const error = new Failure(code)
    value.ready.reject(error)
    if (value.ack) {
      clearTimeout(value.ack.timer)
      value.ack.reject(error)
      value.ack = undefined
    }
    value.lease.abort()
    value.lease.release()
    if (notify) {
      try {
        value.emit({ type: "closed", ...value.request, code })
      } catch {}
    }
  }
  private progress(value: Pending) {
    this.assert(value)
    clearTimeout(value.idle)
    value.idle = setTimeout(() => this.end(value, "unavailable"), this.options.idleMs ?? 45_000)
  }
  private async access(value: Pending, captured?: Desktop.Connection) {
    this.assert(value)
    const access = await this.options.access(value.request.connectionID)
    this.assert(value)
    const connection = Desktop.Connection.parse(access.connection)
    if (
      connection.id !== value.request.connectionID ||
      connection.revision !== value.request.revision ||
      connection.state !== "ready"
    )
      throw new Failure("connection_changed")
    if (
      captured &&
      (connection.orgID !== captured.orgID ||
        connection.issuer !== captured.issuer ||
        connection.clientID !== captured.clientID ||
        connection.deploymentIncarnation !== captured.deploymentIncarnation ||
        connection.account.accountID !== captured.account.accountID ||
        connection.account.authRevision !== captured.account.authRevision)
    )
      throw new Failure("identity_changed")
    return { connection, accessToken: access.accessToken }
  }
  async start(input: unknown, current: () => boolean, emit: (value: Desktop.NotificationEvent) => void): Promise<void> {
    const parsed = Desktop.NotificationStart.safeParse(input)
    if (!parsed.success) throw new Failure("invalid_request")
    const request = parsed.data
    if (
      this.pending.has(request.requestID) ||
      [...this.pending.values()].some((value) => value.request.connectionID === request.connectionID)
    )
      throw new Failure("request_in_progress")
    const lease = this.options.reserve(request.requestID, request.connectionID, current)
    const value: Pending = {
      request,
      lease,
      current,
      emit,
      ready: completion(),
      cancel: () => this.end(value, "cancelled"),
    }
    void value.ready.promise.catch(() => {})
    this.pending.set(request.requestID, value)
    lease.signal.addEventListener("abort", value.cancel, { once: true })
    try {
      this.progress(value)
      void this.read(value).catch((error: unknown) =>
        this.end(value, error instanceof Failure ? error.code : "invalid_response"),
      )
      await value.ready.promise
    } catch (error) {
      this.end(value, error instanceof Failure ? error.code : "invalid_response")
      throw error
    }
  }
  private async read(value: Pending) {
    const access = await this.access(value)
    const connection = access.connection
    const audience = {
      orgID: connection.orgID,
      accountID: connection.account.accountID,
      deploymentIncarnation: connection.deploymentIncarnation,
      authRevision: connection.account.authRevision,
    }
    const signal = value.lease.signal
    const fetcher = this.options.fetch ?? globalThis.fetch
    const guardedFetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        this.assert(value)
        const request = new Request(input, init)
        if (request.method !== "GET" || request.url !== `${connection.issuer}/org/v1/notifications`)
          throw new Failure("invalid_request")
        const response = await fetcher(request)
        try {
          this.assert(value)
        } catch (error) {
          await response.body?.cancel().catch(() => {})
          throw error
        }
        if (
          response.status !== 200 ||
          response.redirected ||
          !response.body ||
          !/^text\/event-stream(?:;|$)/i.test(response.headers.get("content-type") ?? "")
        ) {
          await response.body?.cancel().catch(() => {})
          throw new Failure(
            response.status === 401
              ? "reauthorization_required"
              : response.status === 403
                ? "permission_denied"
                : "invalid_response",
          )
        }
        const frames = Notification.read(response.body, audience, signal)
        const body = new ReadableStream<Uint8Array>(
          {
            async pull(controller) {
              try {
                const next = await frames.next()
                if (next.done) controller.close()
                else controller.enqueue(Notification.encode(next.value))
              } catch (error) {
                controller.error(error)
              }
            },
            async cancel() {
              await frames.return(undefined)
            },
          },
          { highWaterMark: 0 },
        )
        return new Response(body, { headers: { "content-type": "text/event-stream" } })
      },
      { preconnect() {} },
    )
    const client = createOrganizationClient({
      baseUrl: connection.issuer,
      fetch: guardedFetch,
      headers: { authorization: `Bearer ${access.accessToken}` },
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    })
    let failure: unknown
    const { stream } = await client.orgNotifications.stream({
      signal,
      sseMaxRetryAttempts: 1,
      onSseError(error) {
        failure = error
      },
    })
    for await (const input of stream) {
      const frame = Notification.Frame.parse(input)
      await this.access(value, connection)
      this.progress(value)
      const ack = completion()
      void ack.promise.catch(() => {})
      value.ack = {
        streamID: frame.streamID,
        sequence: frame.sequence,
        resolve: () => ack.resolve(),
        reject: ack.reject,
        timer: setTimeout(() => this.end(value, "unavailable"), this.options.ackMs ?? 5000),
      }
      value.emit({ type: "frame", ...value.request, frame })
      if (frame.type === "ready") value.ready.resolve()
      await ack.promise
    }
    if (failure) throw failure
    this.end(value, "unavailable")
  }
  ack(input: unknown, current: () => boolean) {
    const parsed = Desktop.NotificationAck.safeParse(input)
    if (!parsed.success) throw new Failure("invalid_request")
    const request = parsed.data
    const value = this.pending.get(request.requestID)
    if (!value || value.request.connectionID !== request.connectionID || !current()) throw new Failure("cancelled")
    this.assert(value)
    const ack = value.ack
    if (!ack || ack.streamID !== request.streamID || ack.sequence !== request.sequence)
      throw new Failure("invalid_request")
    value.ack = undefined
    clearTimeout(ack.timer)
    ack.resolve()
  }
  stop(input: unknown, current: () => boolean) {
    const parsed = Desktop.NotificationSubscription.safeParse(input)
    if (!parsed.success) throw new Failure("invalid_request")
    const request = parsed.data
    const value = this.pending.get(request.requestID)
    if (!value) return
    if (value.request.connectionID !== request.connectionID || !current()) throw new Failure("cancelled")
    this.end(value, "cancelled")
  }
}
