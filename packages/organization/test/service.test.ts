import { afterAll, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { openOrganizationService } from "../src/service"
import { organizationOpenApi } from "../src/http"
import { organization } from "../src/component"
import { FeatureSelection } from "@ericsanchezok/synergy-util/features"
import { createOrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import { TransactionalStore } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { OrganizationStoragePath } from "../src/storage/path"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"

const homes: string[] = []
const services: Awaited<ReturnType<typeof openOrganizationService>>[] = []
async function open(home?: string) {
  const selected = home ?? (await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "organization-")))
  if (!home) homes.push(selected)
  const service = await openOrganizationService({ home: selected })
  services.push(service)
  return service
}
afterAll(async () => {
  await Promise.all(services.map((service) => service.close()))
  await Promise.all(homes.map((home) => fs.rm(home, { recursive: true, force: true })))
})

test("isolated services preserve deployment identity across restart and never register execution", async () => {
  const first = await open()
  const second = await open()
  const identity = await first.deployment()
  expect(identity.orgID).not.toBe((await second.deployment()).orgID)
  expect(identity.schemaVersion).toBe(1)
  expect(await first.capabilities()).toEqual({ protocolVersion: 1, executesAgents: false })
  const response = await first.fetch(new Request("http://organization/org/v1/health"))
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ready: true, protocolVersion: 1 })
  expect((await first.fetch(new Request("http://organization/session"))).status).toBe(404)
  await first.close()
  expect((await second.deployment()).orgID).not.toBe(identity.orgID)
  const reopened = await open(first.home)
  expect(await reopened.deployment()).toEqual(identity)
  await expect(first.deployment()).rejects.toThrow("closed")
})

test("a second service cannot take a live service's Home", async () => {
  const first = await open()
  await expect(openOrganizationService({ home: first.home })).rejects.toThrow("already owns")
  expect((await first.fetch(new Request("http://organization/org/v1/health"))).status).toBe(200)
})

test("shutdown drains storage telemetry before disposing the service context", async () => {
  const service = await open()
  await service.deployment()
  await service.close()
  await Bun.sleep(1200)
  const restarted = await open(service.home)
  expect((await restarted.fetch(new Request("http://organization/org/v1/health"))).status).toBe(200)
})

test("startup and restart perform no outbound model or network requests", async () => {
  const network = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async () => {
        throw new Error("Organization startup attempted an outbound request")
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  )
  try {
    const service = await open()
    await service.close()
    const restarted = await open(service.home)
    await restarted.deployment()
    await restarted.close()
    expect(network).not.toHaveBeenCalled()
  } finally {
    network.mockRestore()
  }
})

test("the generated organization client reaches the mounted service over real HTTP", async () => {
  const service = await open()
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: service.fetch })
  try {
    const client = createOrganizationClient({ baseUrl: server.url.toString() })
    expect((await client.orgHealth.get({ throwOnError: true })).data).toEqual({ ready: true, protocolVersion: 1 })
    const spec = await organizationOpenApi()
    expect(spec.paths?.["/org/v1/health"]?.get?.operationId).toBe("orgHealth.get")
  } finally {
    await server.stop(true)
  }
})

test("the generated identity client preserves cookies, CSRF and required request bodies", async () => {
  const home = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "organization-sdk-"))
  homes.push(home)
  const origin = "https://organization.example"
  const service = await openOrganizationService({ home, publicOrigin: origin })
  services.push(service)
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: service.fetch })
  try {
    const client = createOrganizationClient({ baseUrl: server.url.toString(), headers: { origin } })
    const input = {
      token: await service.bootstrapToken(),
      requestID: crypto.randomUUID(),
      organizationName: "SDK",
      loginName: "owner",
      displayName: "Owner",
      password: "a long integration password",
    }
    expect((await client.orgSetup.bootstrap({ orgBootstrapInput: input }, { throwOnError: true })).data.role).toBe(
      "owner",
    )
    const login = await client.orgAuth.login(
      { orgLoginInput: { loginName: input.loginName, password: input.password } },
      { throwOnError: true },
    )
    const headers = {
      cookie: login.response.headers.get("set-cookie")!.split(";")[0],
      "x-csrf-token": login.data.csrfToken,
    }
    const created = await client.orgProjects.create(
      { orgProjectCreate: { name: "Through the SDK" } },
      { headers, throwOnError: true },
    )
    expect(created.data.permissions.execute).toBe(true)
    const rejected = await client.orgProjects.create(
      { orgProjectCreate: { name: "Rejected" } },
      { headers: { ...headers, "x-csrf-token": "invalid" } },
    )
    expect(rejected.response.status).toBe(403)
    expect(rejected.error?.code).toBe("PERMISSION_DENIED")
    const spec = await organizationOpenApi()
    expect(spec.paths?.["/org/v1/auth/login"]?.post?.requestBody).toMatchObject({ required: true })
    expect(spec.paths?.["/org/v1/projects/{projectID}"]?.patch?.operationId).toBe("orgProjects.update")
  } finally {
    await server.stop(true)
  }
})

test("the organization component stays off until selected explicitly", () => {
  const components = [organization()]
  expect(FeatureSelection.resolve(components).components).toEqual([])
  expect(FeatureSelection.resolve(components, { optIn: ["organization"] }).components).toEqual(["organization"])
})

test("installing organization commands does not register service migrations in an Agent Runtime", async () => {
  const home = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "organization-component-"))
  homes.push(home)
  const context = RuntimeContext.create({
    home,
    root: path.join(home, ".synergy"),
    env: { SYNERGY_TEST_HOME: process.env.SYNERGY_TEST_HOME },
  })
  try {
    context.run(() => {
      organization().register()
      expect(MigrationRegistry.list().has("organization")).toBe(false)
    })
  } finally {
    context.dispose()
  }
})

test("failed storage startup releases only its own Home lock", async () => {
  const home = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "organization-failed-"))
  homes.push(home)
  const database = path.join(home, ".synergy", "data", "organization.sqlite")
  await fs.mkdir(path.dirname(database), { recursive: true })
  await Bun.write(database, "invalid database")
  await expect(openOrganizationService({ home })).rejects.toThrow()
  await fs.rm(database)
  const service = await open(home)
  expect((await service.deployment()).schemaVersion).toBe(1)
})

test("an unsupported persisted organization schema never becomes ready", async () => {
  const service = await open()
  const deployment = await service.deployment()
  await service.close()
  const store = await TransactionalStore.open({
    backend: "sqlite",
    namespace: "organization",
    filename: path.join(service.home, ".synergy", "data", "organization.sqlite"),
  })
  try {
    await store.transaction((tx) => tx.write(OrganizationStoragePath.deployment(), { ...deployment, schemaVersion: 2 }))
  } finally {
    await store.close()
  }
  await expect(open(service.home)).rejects.toThrow()
})
