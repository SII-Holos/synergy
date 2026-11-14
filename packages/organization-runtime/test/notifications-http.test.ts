import { expect, test } from "bun:test"
import path from "node:path"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { createOrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import { OrganizationNotificationProtocol as Notification } from "@ericsanchezok/synergy-organization-protocol"
import { subscribeOrganizationNotifications } from "../../../apps/web/src/organization/notification-subscription"
import { prepareMemberHome } from "../src/home"
import { enrollMemberRuntime } from "../src/enrollment"
import { readMemberRegistration } from "../src/registration"
import { openMemberRuntime } from "../src/runtime"
import { fixture } from "./support/organization"

async function within<T>(work: Promise<T>, milliseconds: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Notification fixture timed out")), milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

test("a real native completion reaches the Web adapter through authenticated WSS and HTTPS without private content", async () => {
  await using service = await fixture()
  const transport = new Bun.FetchSession({ tls: { ca: service.ca, rejectUnauthorized: true }, proxy: false })
  let subscription: ReturnType<typeof subscribeOrganizationNotifications> | undefined
  let signal: AbortSignal | undefined
  try {
    const options = { headers: service.headers, throwOnError: true as const }
    const { account } = (await service.client.orgAuth.session(options)).data
    const deployment = await service.service.deployment()
    const opened = Promise.withResolvers<void>()
    const delivered = Promise.withResolvers<Notification.Observation>()
    void delivered.promise.catch(() => {})
    subscription = subscribeOrganizationNotifications({
      audience: {
        orgID: account.orgID,
        accountID: account.accountID,
        authRevision: account.authRevision,
        deploymentIncarnation: deployment.deploymentIncarnation,
      },
      source: {
        kind: "web",
        client(original, project) {
          signal = original
          return createOrganizationClient({
            baseUrl: service.origin,
            headers: service.headers,
            redirect: "error",
            fetch: Object.assign(
              async (input: RequestInfo | URL, init?: RequestInit) => {
                const response = await transport.fetch(new Request(input, { ...init, signal: original }))
                expect(response.status).toBe(200)
                expect(response.headers.get("content-type")).toStartWith("text/event-stream")
                const result = project(response)
                opened.resolve()
                return result
              },
              { preconnect() {} },
            ),
          })
        },
      },
      current: () => true,
      receive: (notice) => delivered.resolve(notice),
      failed(error) {
        opened.reject(error)
        delivered.reject(error)
      },
    })
    await within(opened.promise, 5000)
    expect((await transport.fetch(`${service.origin}/org/v1/notifications`)).status).toBe(401)
    expect(
      (
        await transport.fetch(`${service.origin}/org/v1/notifications`, {
          headers: { authorization: `Bearer sy_api_${"a".repeat(64)}` },
        })
      ).status,
    ).toBe(403)
    const member = await prepareMemberHome({
      baseDirectory: path.join(service.root, "notification-member"),
      identity: service.identity,
      origin: service.origin,
    })
    await enrollMemberRuntime({
      home: member.home,
      identity: member.identity,
      ticket: await service.ticket(member.identity.deviceID, member.publicKey),
      ca: service.ca,
    })
    const registration = (await readMemberRegistration(member.home, member.identity))!
    const project = (
      await service.client.orgProjects.create({ orgProjectCreate: { name: "Notifications", description: "" } }, options)
    ).data
    const online = Promise.withResolvers<void>()
    service.interceptFrames((_socket, frame) => {
      if (JSON.parse(String(frame)).type === "heartbeat") online.resolve()
      return false
    })
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
    const port = probe.port!
    await probe.stop(true)
    await using runtime = await openMemberRuntime({
      home: member.home,
      identity: member.identity,
      ca: service.ca,
      listen: { port, token: "b".repeat(64) },
    })
    await within(online.promise, 3000)
    const created = (
      await service.client.orgSessions.create(
        {
          orgCommandCreateRequest: {
            schemaVersion: 1,
            orgID: member.identity.orgID,
            projectID: project.projectID,
            runtimeID: registration.runtimeID,
            requestID: "notification-create",
            creation: { operation: "create", title: "Private title excluded from notifications" },
          },
        },
        options,
      )
    ).data
    const sessionID = created.effect.sessionID
    await runtime.run(async () => {
      const session = await Session.get(sessionID)
      await ScopeContext.provide({
        scope: session.scope,
        workspace: null,
        fn: () => Session.recordCompletionNotice(sessionID),
      })
    })
    const notice = await within(delivered.promise, 5000)
    expect(notice).toMatchObject({
      kind: "completion",
      sessionID,
      binding: {
        orgID: member.identity.orgID,
        projectID: project.projectID,
        creatorID: member.identity.accountID,
        driverRuntimeID: registration.runtimeID,
        bindingEpoch: 1,
      },
    })
    expect(JSON.stringify(notice)).not.toContain("Private title")
    expect(JSON.stringify(notice)).not.toContain(member.home)
    subscription.dispose()
    await subscription.closed
    expect(signal?.aborted).toBe(true)
  } finally {
    subscription?.dispose()
    await subscription?.closed
    await transport.close()
  }
})
