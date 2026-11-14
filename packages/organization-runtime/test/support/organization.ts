import fs from "node:fs/promises"
import path from "node:path"
import { openOrganizationService } from "@ericsanchezok/synergy-organization/service"
import { createOrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import { testResources } from "@ericsanchezok/synergy-testing/resources"
import { cert, key } from "@ericsanchezok/synergy-testing/organization-tls"

type Service = Awaited<ReturnType<typeof openOrganizationService>>
type Socket = Parameters<Service["websocket"]["message"]>[0]

export async function fixture(options: Pick<Parameters<typeof openOrganizationService>[0], "cloud"> = {}) {
  const resources = testResources()
  try {
    const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "member-runtime-"))
    resources.defer("member fixture directory", () => fs.rm(root, { recursive: true, force: true }))
    const service = await openOrganizationService({
      home: path.join(root, "service"),
      publicOrigin: "https://organization.example",
      connections: { heartbeatMs: 25, offlineMs: 300 },
      cloud: options.cloud,
    })
    resources.defer("organization service", () => service.close())
    const requests: Array<{ url: string; cookie: string | null; authorization: string | null; body: string }> = []
    let lostResponse = false
    let intercept: ((socket: Socket, frame: string | Buffer) => boolean) | undefined
    let http: ((request: Request) => Response | undefined | Promise<Response | undefined>) | undefined
    let closeObserver:
      | ((value: {
          code: number
          reason: string
          readyState: number
          pendingFrames: number
          pendingBytes: number
          runtimeID?: string
          epoch: number
          wallTimeMs: number
          leaseRemainingMs: number
        }) => void)
      | undefined
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: { cert, key },
      websocket: {
        ...service.websocket,
        close(socket, code, reason) {
          const result = service.websocket.close?.(socket, code, reason)
          closeObserver?.({
            code,
            reason,
            readyState: socket.readyState,
            pendingFrames: socket.data.frames,
            pendingBytes: socket.data.bytes,
            runtimeID: socket.data.handshake?.runtimeID,
            epoch: socket.data.handshake?.connectionEpoch ?? 0,
            wallTimeMs: Date.now(),
            leaseRemainingMs: Math.max(0, socket.data.deadline - Date.now()),
          })
          return result
        },
        message(socket, frame) {
          if (intercept?.(socket, frame)) return
          return service.websocket.message(socket, frame)
        },
      },
      async fetch(request, server) {
        const intercepted = await http?.(request)
        if (intercepted) return intercepted
        if (new URL(request.url).pathname === "/runtime/v1/register")
          requests.push({
            url: request.url,
            cookie: request.headers.get("cookie"),
            authorization: request.headers.get("authorization"),
            body: await request.clone().text(),
          })
        const response = await service.fetch(request, server)
        if (lostResponse && new URL(request.url).pathname === "/runtime/v1/register") {
          lostResponse = false
          return Response.json(
            { code: "SERVICE_UNAVAILABLE", message: "Response unavailable", retryable: true, outcome: "unknown" },
            { status: 503 },
          )
        }
        return response
      },
    })
    resources.defer("organization HTTPS listener", async () => {
      await server.stop(true)
    })
    const origin = server.url.origin
    const transport = new Bun.FetchSession({ tls: { ca: cert, rejectUnauthorized: true }, proxy: false })
    resources.defer("organization client TLS pool", () => transport.close())
    const client = createOrganizationClient({
      baseUrl: origin,
      fetch: Object.assign(transport.fetch, { preconnect() {} }),
      headers: { origin: "https://organization.example" },
    })
    const password = "a long integration password"
    const account = (
      await client.orgSetup.bootstrap(
        {
          orgBootstrapInput: {
            token: await service.bootstrapToken(),
            requestID: crypto.randomUUID(),
            organizationName: "Runtime test",
            loginName: "owner",
            displayName: "Owner",
            password,
          },
        },
        { throwOnError: true },
      )
    ).data
    const login = await client.orgAuth.login(
      { orgLoginInput: { loginName: "owner", password } },
      { throwOnError: true },
    )
    const headers = {
      cookie: login.response.headers.get("set-cookie")!.split(";")[0],
      "x-csrf-token": login.data.csrfToken,
    }
    return {
      [Symbol.asyncDispose]: resources.close,
      root,
      origin,
      service,
      client,
      headers,
      requests,
      ca: cert,
      stopListener() {
        return server.stop(true)
      },
      observeClose(value: typeof closeObserver) {
        closeObserver = value
      },
      interceptFrames(value: typeof intercept) {
        intercept = value
      },
      interceptHTTP(value: typeof http) {
        http = value
      },
      identity: { orgID: account.orgID, accountID: account.accountID, deviceID: "fixture-device" },
      loseRegistrationResponse() {
        lostResponse = true
      },
      async ticket(deviceID: string, publicKey: string) {
        return (
          await client.orgRuntime.registerMember(
            { orgMemberRuntimeRegistration: { deviceID, publicKey } },
            { headers, throwOnError: true },
          )
        ).data
      },
    }
  } catch (error) {
    try {
      await resources.close()
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Organization fixture setup failed")
    }
    throw error
  }
}
