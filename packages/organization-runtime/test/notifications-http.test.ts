import { expect, test } from "bun:test"
import path from "node:path"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
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

function frames(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder()
  let pending = ""
  return () =>
    within(
      (async () => {
        while (true) {
          const boundary = pending.indexOf("\n\n")
          if (boundary >= 0) {
            const frame = pending.slice(0, boundary)
            pending = pending.slice(boundary + 2)
            const data = frame.split("\n").find((line) => line.startsWith("data: "))
            if (data) {
              const value: unknown = JSON.parse(data.slice(6))
              return value
            }
            continue
          }
          const chunk = await reader.read()
          if (chunk.done) throw new Error("Notification stream ended before its frame")
          pending += decoder.decode(chunk.value, { stream: true })
          if (pending.length > 16_384) throw new Error("Notification frame exceeded its transport bound")
        }
      })(),
      5000,
    )
}

test("a real native completion reaches an authenticated ephemeral HTTPS notification stream without private content", async () => {
  await using service = await fixture()
  const transport = new Bun.FetchSession({ tls: { ca: service.ca, rejectUnauthorized: true }, proxy: false })
  const controller = new AbortController()
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const response = await transport.fetch(`${service.origin}/org/v1/notifications`, {
      headers: service.headers,
      signal: controller.signal,
    })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toStartWith("text/event-stream")
    reader = response.body!.getReader()
    const next = frames(reader)
    expect(await next()).toMatchObject({ type: "ready", sequence: 0, accountID: service.identity.accountID })
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
    const options = { headers: service.headers, throwOnError: true as const }
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
    const notice = await next()
    expect(notice).toMatchObject({
      type: "notice",
      sequence: 1,
      notice: {
        kind: "completion",
        sessionID,
        binding: {
          orgID: member.identity.orgID,
          projectID: project.projectID,
          creatorID: member.identity.accountID,
          driverRuntimeID: registration.runtimeID,
          bindingEpoch: 1,
        },
      },
    })
    expect(JSON.stringify(notice)).not.toContain("Private title")
    expect(JSON.stringify(notice)).not.toContain(member.home)
  } finally {
    controller.abort()
    await reader?.cancel().catch(() => {})
    reader?.releaseLock()
    await transport.close()
  }
})
