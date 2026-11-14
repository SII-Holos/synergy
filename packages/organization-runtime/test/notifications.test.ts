import { expect, test } from "bun:test"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionEvent } from "@ericsanchezok/synergy-harness/session/event"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import {
  OrganizationNotificationProtocol as Notification,
  OrganizationRuntimeProtocol as Runtime,
} from "@ericsanchezok/synergy-organization-protocol"
import { registerSessionSchema } from "../src/session-schema"
import { startMemberNotifications } from "../src/notifications"

test("native observation requires an original root binding and retires the captured connection callback", async () => {
  const binding = {
    schemaVersion: 1 as const,
    orgID: "org",
    projectID: "project",
    creatorID: "account",
    driverRuntimeID: "runtime",
    bindingEpoch: 1,
  }
  await using runtime = await testRuntime({ register: () => registerSessionSchema({ orgID: binding.orgID }) })
  await runtime.run(async () => {
    const scope = await Scope.registerProject({
      type: "project",
      id: "project",
      local: null,
      time: { created: 1, updated: 1 },
    })
    await ScopeContext.provide({
      scope,
      workspace: null,
      fn: async () => {
        const session = await Session.create({ organization: binding, workspaceID: null })
        const source = Session.notificationSource(session)!
        const notices: Notification.Observation[] = []
        const work = new AbortController()
        const connection = {
          signal: work.signal,
          connected: Runtime.Connected.parse({
            type: "handshake",
            protocolVersion: 1,
            orgID: "org",
            deploymentIncarnation: "deployment",
            runtimeID: "runtime",
            connectionEpoch: 1,
            heartbeatMs: 10,
            offlineMs: 100,
            notifications: 1,
            signingIdentity: {
              schemaVersion: 1,
              orgID: "org",
              deploymentIncarnation: "deployment",
              keyID: "key",
              publicKey: "a".repeat(64),
            },
          }),
          notify(notice: Notification.Observation) {
            notices.push(notice)
          },
        }
        const stop = startMemberNotifications(connection, work.signal)
        try {
          await Session.recordCompletionNotice(session.id)
          await Bus.publish(SessionEvent.Error, {
            sessionID: session.id,
            source,
            error: "Private error must stay native",
          })
          await Bus.publish(SessionEvent.Error, { sessionID: session.id, error: "Missing owner" })
          await Bus.publish(SessionEvent.Completion, {
            sessionID: session.id,
            unreadCount: 1,
            source: { ...source, parentID: "parent" },
          })
          await Bus.publish(SessionEvent.Completion, {
            sessionID: session.id,
            unreadCount: 1,
            source: { ...source, references: { "organization-runtime": { version: 2, fields: binding } } },
          })
          expect(notices.map((notice) => notice.kind)).toEqual(["completion", "error"])
          expect(JSON.stringify(notices)).not.toContain("Private error")
          stop()
          await Bus.publish(SessionEvent.Completion, { sessionID: session.id, unreadCount: 1, source })
          expect(notices).toHaveLength(2)
        } finally {
          stop()
          work.abort()
        }
      },
    })
  })
})
