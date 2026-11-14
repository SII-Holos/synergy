import {
  OrganizationDesktop as Desktop,
  OrganizationNotificationProtocol as Notification,
} from "@ericsanchezok/synergy-organization-protocol"
import type { OrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import { generateSecureUUID } from "@ericsanchezok/synergy-util/uuid"

type NativeBridge = Pick<
  Desktop.Bridge,
  "protocolVersion" | "notificationVersion" | "notificationStart" | "notificationStop" | "onNotification"
>
type Source =
  | { kind: "desktop"; bridge: NativeBridge; connectionID: string; revision: string }
  | { kind: "web"; client(signal: AbortSignal, response: (input: Response) => Response): OrganizationClient }
export class OrganizationNotificationFailure extends Error {
  constructor(readonly code: Desktop.ErrorCode) {
    super("Organization notifications are unavailable")
  }
}
export function subscribeOrganizationNotifications(input: {
  audience: Notification.Audience
  source: Source
  current(): boolean
  receive(notice: Notification.Observation): void | Promise<void>
  failed(error: OrganizationNotificationFailure): void
}) {
  const audience = Notification.Audience.parse(input.audience)
  const source = { ...input.source }
  const current = input.current
  const receive = input.receive
  const failed = input.failed
  const controller = new AbortController()
  const frames = Notification.receiver(audience)
  let active = true
  let stop: (() => void) | undefined
  let unsubscribe: (() => void) | undefined
  let resolve!: () => void
  const closed = new Promise<void>((done) => {
    resolve = done
  })
  const valid = () => active && !controller.signal.aborted && current()
  function finish(error?: OrganizationNotificationFailure) {
    if (!active) return
    const report = error && current()
    active = false
    controller.abort()
    unsubscribe?.()
    stop?.()
    resolve()
    if (report) failed(error)
  }
  function failure(error: unknown) {
    const code = Desktop.ErrorCode.safeParse(
      error && typeof error === "object" && "code" in error ? error.code : undefined,
    )
    finish(new OrganizationNotificationFailure(code.success ? code.data : "invalid_response"))
  }
  async function consume(input: unknown) {
    if (!valid()) {
      finish()
      return
    }
    const frame = frames.accept(input)
    if (frame.type === "notice") await receive(frame.notice)
    if (!valid()) finish()
  }
  if (!valid()) finish()
  else if (source.kind === "desktop") {
    const bridge = source.bridge
    const start = bridge.notificationStart?.bind(bridge)
    const end = bridge.notificationStop?.bind(bridge)
    const listen = bridge.onNotification?.bind(bridge)
    if (
      bridge.protocolVersion !== Desktop.BridgeVersion ||
      bridge.notificationVersion !== Desktop.NotificationVersion ||
      !start ||
      !end ||
      !listen
    )
      finish(new OrganizationNotificationFailure("bridge_incompatible"))
    else {
      const request = { requestID: generateSecureUUID(), connectionID: source.connectionID, revision: source.revision }
      stop = () => {
        void end({ requestID: request.requestID, connectionID: request.connectionID }).catch(() => {})
      }
      unsubscribe = listen(async (input) => {
        if (
          input.requestID !== request.requestID ||
          input.connectionID !== request.connectionID ||
          input.revision !== request.revision
        )
          return
        if (!valid()) {
          finish()
          return
        }
        try {
          const event = Desktop.NotificationEvent.parse(input)
          if (event.type === "closed") {
            finish(new OrganizationNotificationFailure(event.code))
            return
          }
          await consume(event.frame)
        } catch (error) {
          failure(error)
        }
      })
      void start(request)
        .then((result) => {
          if (!valid()) {
            stop?.()
            return
          }
          if (!result.ok) finish(new OrganizationNotificationFailure(result.error.code))
        })
        .catch(failure)
    }
  } else {
    const createClient = source.client
    const response = (input: Response) => {
      if (!valid()) {
        void input.body?.cancel().catch(() => {})
        throw new OrganizationNotificationFailure("cancelled")
      }
      if (
        input.status !== 200 ||
        input.redirected ||
        !input.body ||
        !/^text\/event-stream(?:;|$)/i.test(input.headers.get("content-type") ?? "")
      ) {
        void input.body?.cancel().catch(() => {})
        throw new OrganizationNotificationFailure(
          input.status === 401
            ? "reauthorization_required"
            : input.status === 403
              ? "permission_denied"
              : input.status === 404
                ? "bridge_incompatible"
                : "unavailable",
        )
      }
      const decoded = Notification.read(input.body, audience, controller.signal)
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            async pull(value) {
              try {
                const next = await decoded.next()
                if (next.done) value.close()
                else value.enqueue(Notification.encode(next.value))
              } catch (error) {
                value.error(error)
              }
            },
            async cancel() {
              await decoded.return(undefined)
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { "content-type": "text/event-stream" } },
      )
    }
    void (async () => {
      let error: unknown
      const { stream } = await createClient(controller.signal, response).orgNotifications.stream({
        signal: controller.signal,
        sseMaxRetryAttempts: 1,
        onSseError(value) {
          error = value
        },
      })
      for await (const frame of stream) {
        await consume(frame)
        if (!valid()) return
      }
      if (error) throw error
      finish(new OrganizationNotificationFailure("unavailable"))
    })().catch(failure)
  }
  return { closed, dispose: () => finish() }
}
