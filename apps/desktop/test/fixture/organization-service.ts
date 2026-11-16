import { openOrganizationService } from "@ericsanchezok/synergy-organization/service"
import { createOrganizationClient } from "@ericsanchezok/synergy-sdk/organization"

const issuer = "https://organization.example"
const service = await openOrganizationService({
  home: process.argv[2]!,
  publicOrigin: issuer,
  clientAuthentication: {
    clients: [{ clientID: "desktop", kind: "desktop", redirectUri: "synergy://organization-auth/callback" }],
  },
})
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: service.fetch })
const stop = Promise.withResolvers<void>()
process.once("SIGTERM", () => stop.resolve())
process.once("SIGINT", () => stop.resolve())
try {
  const client = createOrganizationClient({ baseUrl: server.url.toString(), headers: { origin: issuer } })
  await client.orgSetup.bootstrap(
    {
      orgBootstrapInput: {
        token: await service.bootstrapToken(),
        requestID: crypto.randomUUID(),
        organizationName: "Desktop fixture",
        loginName: "owner",
        displayName: "Desktop owner",
        password: "desktop organization fixture password",
      },
    },
    { throwOnError: true },
  )
  const deployment = await service.deployment()
  console.log(
    JSON.stringify({
      url: server.url.toString(),
      issuer,
      orgID: deployment.orgID,
      deploymentIncarnation: deployment.deploymentIncarnation,
    }),
  )
  await stop.promise
} finally {
  await server.stop(true)
  await service.close()
}
