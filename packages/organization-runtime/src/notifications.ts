import { randomUUID } from "node:crypto"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { SessionEvent } from "@ericsanchezok/synergy-harness/session/event"
import { SessionSchemaRegistry } from "@ericsanchezok/synergy-harness/session/schema-registry"
import {
  OrganizationProtocol,
  OrganizationNotificationProtocol as Notification,
} from "@ericsanchezok/synergy-organization-protocol"
import type { MemberConnection } from "./connection"

export function startMemberNotifications(
  connection: Pick<MemberConnection, "connected" | "signal" | "notify">,
  inputSignal: AbortSignal,
) {
  const signal = inputSignal
  const connectionSignal = connection.signal
  const notify = connection.notify.bind(connection)
  const handshake = { ...connection.connected }
  let active = true
  if (handshake.notifications !== Notification.Version)
    return () => {
      active = false
    }
  function publish(kind: Notification.Observation["kind"], sessionID: string | undefined, input: unknown) {
    if (!active || signal.aborted || connectionSignal.aborted || !sessionID) return
    const source = SessionSchemaRegistry.NotificationSource.safeParse(input)
    if (!source.success || source.data.parentID || source.data.sessionID !== sessionID) return
    const reference = source.data.references["organization-runtime"]
    if (reference?.version !== 1) return
    const parsed = OrganizationProtocol.SessionBinding.safeParse(reference.fields)
    if (!parsed.success) return
    const binding = parsed.data
    if (
      source.data.scopeID !== binding.projectID ||
      binding.orgID !== handshake.orgID ||
      binding.driverRuntimeID !== handshake.runtimeID
    )
      return
    notify({ noticeID: randomUUID(), kind, sessionID, binding, occurredAt: Date.now() })
  }
  const subscriptions = [
    Bus.subscribeGlobal(SessionEvent.Completion, (event) =>
      publish("completion", event.properties.sessionID, event.properties.source),
    ),
    Bus.subscribeGlobal(SessionEvent.Error, (event) =>
      publish("error", event.properties.sessionID, event.properties.source),
    ),
  ]
  return () => {
    active = false
    for (const unsubscribe of subscriptions) unsubscribe()
  }
}
