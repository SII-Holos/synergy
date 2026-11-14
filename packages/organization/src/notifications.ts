import { randomUUID } from "node:crypto"
import { z } from "zod"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import {
  OrganizationNotificationProtocol as Notification,
  OrganizationProtocol,
} from "@ericsanchezok/synergy-organization-protocol"
import { authenticateHuman, type Credentials } from "./auth/session"
import { authorize } from "./authorization"
import { OrganizationRecord as Record } from "./storage/records"
import { OrganizationStoragePath as Keys } from "./storage/path"
import { OrganizationError, fail } from "./error"
import type { RuntimeConnectionLease } from "./runtime-connection"

type Subscriber = {
  audience: Notification.Audience
  offer(notice: Notification.Observation, connection: RuntimeConnectionLease): void
  close(): void
}

function matches(session: Record.SessionDirectory, notice: Notification.Observation) {
  const binding = notice.binding
  return (
    session.sessionID === notice.sessionID &&
    session.orgID === binding.orgID &&
    session.projectID === binding.projectID &&
    session.creatorID === binding.creatorID &&
    session.driverRuntimeID === binding.driverRuntimeID &&
    session.bindingEpoch === binding.bindingEpoch
  )
}

export function createOrganizationNotifications(input: {
  run: <T>(body: () => T | Promise<T>) => Promise<T>
  heartbeatMs?: number
}) {
  const run = input.run
  const heartbeatMs = z
    .number()
    .int()
    .min(1)
    .max(60_000)
    .parse(input.heartbeatMs ?? 15_000)
  const subscribers = new Set<Subscriber>()
  let closed = false

  async function audience(credentials: Credentials, expected?: Notification.Audience) {
    const { account } = await authenticateHuman(credentials)
    const deployment = OrganizationProtocol.Deployment.parse(await Storage.read(Keys.deployment()))
    const current = Notification.Audience.parse({
      orgID: account.orgID,
      accountID: account.accountID,
      deploymentIncarnation: deployment.deploymentIncarnation,
      authRevision: account.authRevision,
    })
    if (
      account.orgID !== deployment.orgID ||
      (expected && Object.entries(expected).some(([key, value]) => Reflect.get(current, key) !== value))
    )
      fail("AUTHENTICATION_REQUIRED", "The notification audience changed")
    return current
  }

  async function open(inputCredentials: Credentials, inputSignal: AbortSignal) {
    const credentials = { ...inputCredentials }
    const signal = inputSignal
    signal.throwIfAborted()
    if (closed) fail("SERVICE_UNAVAILABLE", "Notifications are unavailable")
    const captured = await audience(credentials)
    signal.throwIfAborted()
    if (closed) fail("SERVICE_UNAVAILABLE", "Notifications are unavailable")
    const streamID = randomUUID()
    let sequence = 0
    let active = true
    let queuedBytes = 0
    let pending = Promise.resolve()
    let timer: ReturnType<typeof setInterval> | undefined
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    const close = () => {
      if (!active) return
      active = false
      clearInterval(timer)
      signal.removeEventListener("abort", close)
      subscribers.delete(subscriber)
      try {
        controller?.close()
      } catch {}
    }
    const write = (frame: Notification.Frame) => {
      if (!active || signal.aborted) return
      const bytes = Notification.encode(frame)
      if (!controller || (controller.desiredSize ?? 0) < bytes.byteLength) {
        close()
        return
      }
      controller.enqueue(bytes)
    }
    const queue = (bytes: number, task: () => Promise<void>) => {
      if (!active || signal.aborted) return
      if (queuedBytes + bytes > Notification.PendingLimit) {
        close()
        return
      }
      queuedBytes += bytes
      pending = pending
        .then(async () => {
          if (active && !signal.aborted) await task()
        })
        .catch(close)
        .finally(() => {
          queuedBytes -= bytes
        })
    }
    const subscriber: Subscriber = {
      audience: captured,
      close,
      offer(notice, connection) {
        const bytes = Notification.encode({ type: "notice", streamID, sequence: sequence + 1, notice }).byteLength
        queue(bytes, async () => {
          await run(async () => {
            if (!active || signal.aborted) return
            await audience(credentials, captured)
            try {
              connection.assertCurrent()
              const { session } = await authorize(credentials, "session.read", { sessionID: notice.sessionID })
              connection.assertCurrent()
              if (matches(session, notice) && active && !signal.aborted)
                write({ type: "notice", streamID, sequence: ++sequence, notice })
            } catch (error) {
              if (
                error instanceof OrganizationError &&
                ["NOT_FOUND", "PERMISSION_DENIED", "STALE_CONNECTION", "RUNTIME_OFFLINE"].includes(error.data.code)
              )
                return
              throw error
            }
          })
        })
      },
    }
    const stream = new ReadableStream<Uint8Array>(
      {
        start(value) {
          controller = value
          write({ type: "ready", streamID, sequence: 0, ...captured })
        },
        cancel: close,
      },
      { highWaterMark: Notification.PendingLimit, size: (chunk) => chunk?.byteLength ?? 0 },
    )
    subscribers.add(subscriber)
    signal.addEventListener("abort", close, { once: true })
    if (signal.aborted) close()
    timer = setInterval(
      () =>
        queue(256, async () => {
          await run(async () => {
            await audience(credentials, captured)
            if (active && !signal.aborted) write({ type: "heartbeat", streamID, sequence: ++sequence })
          })
        }),
      heartbeatMs,
    )
    timer.unref()
    if (!active) clearInterval(timer)
    return stream
  }

  async function publish(connection: RuntimeConnectionLease, inputNotice: Notification.Observation) {
    if (closed) return
    const notice = Notification.Observation.parse(inputNotice)
    connection.assertCurrent()
    const handshake = connection.handshake
    if (handshake.orgID !== notice.binding.orgID || handshake.runtimeID !== notice.binding.driverRuntimeID) return
    const session = await Record.read(Record.SessionDirectory, Keys.session(notice.sessionID))
    connection.assertCurrent()
    if (!session || !matches(session, notice) || closed) return
    for (const subscriber of subscribers)
      if (subscriber.audience.orgID === notice.binding.orgID) subscriber.offer(notice, connection)
  }

  return {
    open,
    publish,
    close() {
      closed = true
      for (const subscriber of [...subscribers]) subscriber.close()
    },
  }
}
export type OrganizationNotifications = ReturnType<typeof createOrganizationNotifications>
