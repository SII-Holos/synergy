import { openOrganizationService } from "@ericsanchezok/synergy-organization/service"
import { createOrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import { z } from "zod"

const input = z
  .strictObject({
    home: z.string(),
    directory: z.string(),
    clientOrigin: z.string(),
    key: z.string(),
    cert: z.string(),
    issuerHost: z.enum(["localhost", "127.0.0.1"]).default("localhost"),
    organizationName: z.string().min(1).default("Browser fixture"),
    projectName: z.string().min(1).nullable().optional(),
  })
  .parse(JSON.parse(await Bun.stdin.text()))
const stopped = Promise.withResolvers<void>()
process.on("SIGTERM", () => stopped.resolve())
process.on("SIGINT", () => stopped.resolve())
let service: Awaited<ReturnType<typeof openOrganizationService>> | undefined
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  tls: { key: input.key, cert: input.cert },
  fetch: (request) => (service ? service.fetch(request) : new Response(null, { status: 503 })),
})
try {
  const issuer = `https://${input.issuerHost}:${server.port}`
  service = await openOrganizationService({
    home: input.home,
    publicOrigin: issuer,
    web: { directory: input.directory },
    clientAuthentication: {
      clients: [{ clientID: "web", kind: "web", redirectUri: `${input.clientOrigin}/organization.html` }],
    },
  })
  const client = createOrganizationClient({
    baseUrl: issuer,
    fetch: Object.assign((input: RequestInfo | URL, init?: RequestInit) => service!.fetch(new Request(input, init)), {
      preconnect() {},
    }),
    headers: { origin: issuer },
  })
  await client.orgSetup.bootstrap(
    {
      orgBootstrapInput: {
        token: await service.bootstrapToken(),
        requestID: crypto.randomUUID(),
        organizationName: input.organizationName,
        loginName: "owner",
        displayName: "Fixture owner",
        password: "organization browser fixture password",
      },
    },
    { throwOnError: true },
  )
  const login = await client.orgAuth.login(
    { orgLoginInput: { loginName: "owner", password: "organization browser fixture password" } },
    { throwOnError: true },
  )
  const headers = {
    cookie: login.response.headers.get("set-cookie")!.split(";")[0]!,
    "x-csrf-token": login.data.csrfToken,
  }
  const project =
    input.projectName === null
      ? undefined
      : (
          await client.orgProjects.create(
            { orgProjectCreate: { name: input.projectName ?? "Shared project" } },
            { headers, throwOnError: true },
          )
        ).data
  await client.orgAuth.logout({ orgEmptyInput: {} }, { headers, throwOnError: true })
  const deployment = await service.deployment()
  console.log(
    JSON.stringify({
      issuer,
      orgID: deployment.orgID,
      deploymentIncarnation: deployment.deploymentIncarnation,
      projectID: project?.projectID,
    }),
  )
  await stopped.promise
} finally {
  await server.stop(true)
  await service?.close()
}
