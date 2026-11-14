import { expect, test } from "bun:test"
import path from "node:path"
import { RuntimeContext, type RuntimeLaunch } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { ResourceSources } from "@ericsanchezok/synergy-harness/observability/resource-sources"
import { SessionExecutionSource } from "@ericsanchezok/synergy-harness/session/execution-source"
import { prepareMemberHome } from "../src/home"
import { enrollMemberRuntime } from "../src/enrollment"
import { openMemberRuntime } from "../src/runtime"
import { MemberLaunchRequest } from "../src/launch"
import {
  BROWSER_PROTOCOL_VERSION,
  BrowserHostMessageSchema,
  BrowserProtocolErrorSchema,
} from "@ericsanchezok/synergy-browser-core"
import { fixture } from "./support/organization"

async function setup(service: Awaited<ReturnType<typeof fixture>>) {
  const member = await prepareMemberHome({
    baseDirectory: path.join(service.root, "members"),
    identity: service.identity,
    origin: service.origin,
  })
  await enrollMemberRuntime({
    home: member.home,
    identity: member.identity,
    ticket: await service.ticket(member.identity.deviceID, member.publicKey),
    ca: service.ca,
  })
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = reservation.port!
  await reservation.stop(true)
  return {
    home: member.home,
    identity: member.identity,
    ca: service.ca,
    entry: "desktop-managed" as RuntimeLaunch["entry"],
    listen: { port, token: "d".repeat(64) },
    desktop: { browserToken: "b".repeat(64) },
    environment: { ...process.env, SYNERGY_BROWSER_HOST_REGISTRATION_SECRET: "personal-native-secret" },
  }
}

test("member Desktop Browser is explicit, lazy and independent of the personal environment", async () => {
  await using service = await fixture()
  const input = await setup(service)
  {
    await using headless = await openMemberRuntime({ ...input, desktop: undefined })
    expect(headless.components.map((component) => component.id)).not.toContain("browser-runtime")
    await headless.run(() => {
      expect(RuntimeContext.current().host.env.SYNERGY_BROWSER_HOST_REGISTRATION_SECRET).toBeUndefined()
    })
  }
  await using runtime = await openMemberRuntime(input)
  expect(runtime.components.map((component) => component.id)).toContain("browser-runtime")
  await runtime.run(async () => {
    expect(RuntimeContext.current().host.env.SYNERGY_BROWSER_HOST_REGISTRATION_SECRET).toBe(input.desktop.browserToken)
    const resources = await ResourceSources.read()
    expect(resources.find((resource) => resource.owner === "browser")).toMatchObject({ processCount: 0 })
    await expect(
      SessionExecutionSource.authorize({ scopeID: "home", sessionID: "ses_pending" }),
    ).rejects.toBeInstanceOf(SessionExecutionSource.DeniedError)
  })
}, 20_000)

async function handshake(port: number, authorization: string, token: string, origin?: string) {
  const NativeWebSocket = globalThis.WebSocket as unknown as new (
    url: string,
    options: Bun.WebSocketOptions,
  ) => WebSocket
  const Reply = BrowserHostMessageSchema.or(BrowserProtocolErrorSchema)
  const socket = new NativeWebSocket(
    `ws://127.0.0.1:${port}/browser/host/broker?protocolVersion=${BROWSER_PROTOCOL_VERSION}`,
    {
      headers: { authorization, ...(origin ? { origin } : {}) },
    },
  )
  const closed = new Promise<void>((resolve) => socket.addEventListener("close", () => resolve(), { once: true }))
  let timeout: ReturnType<typeof setTimeout> | undefined
  const response = new Promise<ReturnType<typeof Reply.parse> | { type: "closed"; code: number }>((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error("Member native handshake timed out")), 2_000)
    socket.addEventListener("open", () =>
      socket.send(
        JSON.stringify({
          type: "host.register",
          protocolVersion: BROWSER_PROTOCOL_VERSION,
          hostId: "fixture-native",
          token,
          capabilities: { native: true },
        }),
      ),
    )
    socket.addEventListener("message", (event) => {
      try {
        resolve(Reply.parse(JSON.parse(String(event.data))))
      } catch (error) {
        reject(error)
      }
    })
    socket.addEventListener("close", (event) => resolve({ type: "closed", code: event.code }))
    socket.addEventListener("error", () => reject(new Error("Member native upgrade failed")))
  })
  try {
    return await response
  } finally {
    clearTimeout(timeout)
    socket.close()
    await closed
  }
}

test("member Browser brokers require both listener and native credentials and stay Runtime-scoped", async () => {
  await using serviceA = await fixture()
  await using serviceB = await fixture()
  const first = await setup(serviceA)
  const second = await setup(serviceB)
  second.listen.token = "e".repeat(64)
  second.desktop.browserToken = "c".repeat(64)
  await using a = await openMemberRuntime(first)
  await using b = await openMemberRuntime(second)
  const authA = `Bearer ${first.listen.token}`
  const authB = `Bearer ${second.listen.token}`
  expect((await fetch(`http://127.0.0.1:${first.listen.port}/browser/host/broker`)).status).toBe(401)
  await expect(handshake(first.listen.port, authB, first.desktop.browserToken)).rejects.toThrow("upgrade")
  expect(await handshake(first.listen.port, authA, second.desktop.browserToken)).toEqual({ type: "closed", code: 1008 })
  expect(await handshake(first.listen.port, authA, first.desktop.browserToken, "https://web.example")).toMatchObject({
    type: "error",
    code: "browser_route_failed",
  })
  for (const response of await Promise.all([
    handshake(first.listen.port, authA, first.desktop.browserToken),
    handshake(second.listen.port, authB, second.desktop.browserToken),
  ]))
    expect(response.type).toBe("host.registered")
  await a.close()
  expect((await handshake(second.listen.port, authB, second.desktop.browserToken)).type).toBe("host.registered")
}, 20_000)

test("member native options reject non-Desktop or one-shot selection and malformed private credentials", async () => {
  await using service = await fixture()
  const input = await setup(service)
  for (const candidate of [
    { ...input, entry: "embedded" as const },
    { ...input, entry: "cli-server" as const },
    { ...input, entry: "dev-web" as const },
    { ...input, listen: undefined },
    { ...input, desktop: { browserToken: "invalid-private-value" } },
  ]) {
    const error = await openMemberRuntime(candidate).then(
      async (runtime) => {
        await runtime.close()
        return undefined
      },
      (error: unknown) => error,
    )
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toContain("Desktop")
    expect(String(error)).not.toContain("invalid-private-value")
  }
  const request = {
    version: 1,
    identity: input.identity,
    deploymentIncarnation: "deployment",
    ...input.listen,
    desktop: input.desktop,
  }
  expect(MemberLaunchRequest.safeParse(request).success).toBe(true)
  expect(MemberLaunchRequest.safeParse({ ...request, desktop: { browserToken: "invalid" } }).success).toBe(false)
  expect(
    MemberLaunchRequest.safeParse({ ...request, desktop: { ...input.desktop, partition: "personal" } }).success,
  ).toBe(false)
}, 20_000)
