import { expect, test } from "bun:test"
import {
  OrganizationDesktop as Desktop,
  OrganizationNotificationProtocol as Notification,
} from "@ericsanchezok/synergy-organization-protocol"
import { subscribeOrganizationNotifications } from "../../src/organization/notification-subscription"

const audience = { orgID: "org-a", accountID: "account-a", deploymentIncarnation: "deployment-a", authRevision: 1 }
function fixture() {
  const listeners = new Set<(value: Desktop.NotificationEvent) => void | Promise<void>>()
  const starts: Desktop.NotificationStart[] = []
  const stops: Desktop.NotificationSubscription[] = []
  const notices: Notification.Observation[] = []
  const errors: string[] = []
  let current = true
  let selected = "personal"
  const input = {
    audience: { ...audience },
    source: {
      kind: "desktop" as const,
      connectionID: "a".repeat(64),
      revision: "00000000-0000-4000-8000-000000000001",
      bridge: {
        protocolVersion: 2 as const,
        notificationVersion: 1 as const,
        async notificationStart(request: Desktop.NotificationStart): Promise<Desktop.Result<void>> {
          starts.push(request)
          return { ok: true, value: undefined }
        },
        async notificationStop(request: Desktop.NotificationSubscription): Promise<Desktop.Result<void>> {
          stops.push(request)
          return { ok: true, value: undefined }
        },
        onNotification(listener: (value: Desktop.NotificationEvent) => void | Promise<void>) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
    },
    current: () => current,
    receive(notice: Notification.Observation) {
      notices.push(notice)
    },
    failed(error: { code: string }) {
      errors.push(error.code)
    },
  }
  const streamID = "00000000-0000-4000-8000-000000000002"
  const event = (frame: Notification.Frame): Desktop.NotificationEvent => ({ ...starts[0], type: "frame", frame })
  return {
    input,
    starts,
    stops,
    notices,
    errors,
    event,
    ready: () => event({ type: "ready", streamID, sequence: 0, ...audience }),
    notice: (sequence = 1) =>
      event({
        type: "notice",
        streamID,
        sequence,
        notice: {
          noticeID: "00000000-0000-4000-8000-000000000003",
          kind: "completion",
          sessionID: "session-a",
          binding: {
            schemaVersion: 1,
            orgID: "org-a",
            projectID: "project-a",
            creatorID: "other-collaborator",
            driverRuntimeID: "runtime-a",
            bindingEpoch: 1,
          },
          occurredAt: 1,
        },
      }),
    async send(value: Desktop.NotificationEvent) {
      await Promise.all([...listeners].map((listener) => listener(value)))
    },
    select(value: string) {
      selected = value
    },
    get selected() {
      return selected
    },
    retire() {
      current = false
    },
    get listenerCount() {
      return listeners.size
    },
  }
}

test("an inactive organization retains its exact audience while personal or another space is selected", async () => {
  const f = fixture()
  const subscription = subscribeOrganizationNotifications(f.input)
  try {
    expect(f.starts).toHaveLength(1)
    expect(f.listenerCount).toBe(1)
    f.input.audience.accountID = "later-account"
    await f.send(f.ready())
    f.select("organization-b")
    await f.send(f.notice())
    expect(f.selected).toBe("organization-b")
    expect(f.notices).toHaveLength(1)
    expect(f.notices[0].binding).toMatchObject({ orgID: "org-a", projectID: "project-a" })
    expect(f.errors).toEqual([])
  } finally {
    subscription.dispose()
    await subscription.closed
  }
  expect(f.stops).toHaveLength(1)
  expect(f.listenerCount).toBe(0)
})

test("account retirement and disposal reject late source events without adopting a new identity", async () => {
  const f = fixture()
  const subscription = subscribeOrganizationNotifications(f.input)
  await f.send(f.ready())
  f.retire()
  await f.send(f.notice())
  expect(f.notices).toHaveLength(0)
  await subscription.closed
  expect(f.listenerCount).toBe(0)
  expect(f.stops).toHaveLength(1)
  expect(f.errors).toEqual([])
  subscription.dispose()
})

test("a changed stream or frame sequence retires only its own native subscription", async () => {
  const f = fixture()
  const subscription = subscribeOrganizationNotifications(f.input)
  await f.send(f.ready())
  await f.send(f.notice(2))
  await subscription.closed
  expect(f.notices).toHaveLength(0)
  expect(f.errors).toEqual(["invalid_response"])
  expect(f.stops).toHaveLength(1)
})
