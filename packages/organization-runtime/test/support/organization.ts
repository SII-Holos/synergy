import { afterAll } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { openOrganizationService } from "@ericsanchezok/synergy-organization/service"
import { createOrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import { cert, key } from "./fixtures/tls"

const cleanup: Array<() => Promise<void>> = []
afterAll(async () => {
  for (const close of cleanup.reverse()) await close()
})

export async function fixture() {
  const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "member-runtime-"))
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }))
  const service = await openOrganizationService({
    home: path.join(root, "service"),
    publicOrigin: "https://organization.example",
    connections: { heartbeatMs: 25, offlineMs: 300 },
  })
  cleanup.push(() => service.close())
  const requests: Array<{ url: string; cookie: string | null; authorization: string | null; body: string }> = []
  let lostResponse = false
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert, key },
    websocket: service.websocket,
    async fetch(request, server) {
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
  cleanup.push(async () => {
    await server.stop(true)
  })
  const origin = server.url.origin
  const transport = new Bun.FetchSession({ tls: { ca: cert, rejectUnauthorized: true }, proxy: false })
  cleanup.push(async () => transport.close())
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
  const login = await client.orgAuth.login({ orgLoginInput: { loginName: "owner", password } }, { throwOnError: true })
  const headers = {
    cookie: login.response.headers.get("set-cookie")!.split(";")[0],
    "x-csrf-token": login.data.csrfToken,
  }
  return {
    root,
    origin,
    service,
    client,
    headers,
    requests,
    ca: cert,
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
}
