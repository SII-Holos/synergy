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
import { OrganizationRuntimeProtocol as Runtime } from "@ericsanchezok/synergy-organization-protocol"
import { digest } from "../src/auth/secret"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"

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

test("execution metadata upgrades do not read historical Session directories at startup", async () => {
  const service = await open()
  await service.close()
  const store = await TransactionalStore.open({
    backend: "sqlite",
    namespace: "organization",
    filename: path.join(service.home, ".synergy", "data", "organization.sqlite"),
  })
  try {
    await store.transaction((tx) =>
      tx.writeMany(
        Array.from({ length: 257 }, (_, index) => ({
          key: OrganizationStoragePath.session(`cold-${index}`),
          value: { schemaVersion: 1, executionGrantIDs: "corrupt cold record" },
        })),
      ),
    )
  } finally {
    await store.close()
  }
  const readMany = Storage.readMany
  const query = Storage.query
  const scan = Storage.scan
  const historical: string[][] = []
  const reads = spyOn(Storage, "readMany").mockImplementation(async (keys) => {
    historical.push(...keys.filter((key) => key[0] === "organization" && key[1] === "sessions"))
    return readMany(keys)
  })
  const queries = spyOn(Storage, "query").mockImplementation(async (input) => {
    if (input.prefix?.[0] === "organization" && input.prefix[1] === "sessions") historical.push(input.prefix)
    return query(input)
  })
  const scans = spyOn(Storage, "scan").mockImplementation(async (prefix) => {
    if (prefix[0] === "organization" && prefix[1] === "sessions") historical.push(prefix)
    return scan(prefix)
  })
  try {
    const reopened = await open(service.home)
    expect((await reopened.fetch(new Request("http://organization/org/v1/health"))).status).toBe(200)
    expect(historical).toEqual([])
  } finally {
    reads.mockRestore()
    queries.mockRestore()
    scans.mockRestore()
  }
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
    const key = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
    const registered = await client.orgRuntime.registerMember(
      { orgMemberRuntimeRegistration: { deviceID: "sdk-device", publicKey: await Runtime.publicKey(key.publicKey) } },
      { headers, throwOnError: true },
    )
    const proof = Runtime.RegistrationProof.parse({
      purpose: "runtime-register",
      protocolVersion: 1,
      orgID: registered.data.runtime.orgID,
      deploymentIncarnation: registered.data.runtime.deploymentIncarnation,
      runtimeID: registered.data.runtime.runtimeID,
      ticketHash: digest(registered.data.token),
    })
    const activated = await client.orgRuntime.consumeTicket(
      {
        orgRuntimeConsumeTicket: {
          token: registered.data.token,
          proof,
          signature: await Runtime.sign(proof, key.privateKey),
        },
      },
      { throwOnError: true },
    )
    expect(activated.data.state).toBe("active")
    const browserMachineHeaders: Record<string, string>[] = [{ origin }, { cookie: headers.cookie }]
    for (const machineHeaders of browserMachineHeaders) {
      const denied = await fetch(new URL("/runtime/v1/knowledge/selection", server.url), {
        method: "POST",
        headers: { "content-type": "application/json", ...machineHeaders },
        body: JSON.stringify({}),
      })
      expect(denied.status).toBe(403)
      expect(((await denied.json()) as { message: string }).message).toBe(
        "Knowledge execution requires a machine proof",
      )
    }
    expect(
      (await client.orgRuntime.connection({ runtimeID: activated.data.runtimeID }, { headers, throwOnError: true }))
        .data,
    ).toMatchObject({ state: "offline", connectionEpoch: 0 })
    expect((await client.orgRuntime.list(undefined, { headers, throwOnError: true })).data.items).toEqual([
      activated.data,
    ])
    expect(
      (await client.orgRuntime.get({ runtimeID: activated.data.runtimeID }, { headers, throwOnError: true })).data,
    ).toEqual(activated.data)
    expect(
      (
        await client.orgRuntime.revoke(
          { runtimeID: activated.data.runtimeID, orgRuntimeRevoke: { expectedRevision: activated.data.revision } },
          { headers, throwOnError: true },
        )
      ).data.state,
    ).toBe("revoked")
    const spec = await organizationOpenApi()
    expect(spec.paths?.["/org/v1/auth/login"]?.post?.requestBody).toMatchObject({ required: true })
    expect(spec.paths?.["/org/v1/projects/{projectID}"]?.patch?.operationId).toBe("orgProjects.update")
    expect(spec.paths?.["/runtime/v1/register"]?.post?.requestBody).toMatchObject({ required: true })
    expect(spec.paths?.["/org/v1/runtimes/member"]?.post?.operationId).toBe("orgRuntime.registerMember")
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

test("Home ownership upgrades existing organization identity and refuses a personal data directory", async () => {
  const legacy = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "organization-legacy-"))
  homes.push(legacy)
  const root = path.join(legacy, ".synergy")
  await fs.mkdir(path.join(root, "data"), { recursive: true })
  const store = await TransactionalStore.open({
    backend: "sqlite",
    filename: path.join(root, "data", "organization.sqlite"),
    namespace: "organization",
  })
  const deployment = {
    schemaVersion: 1 as const,
    orgID: "legacy-organization",
    deploymentIncarnation: "legacy-deployment",
    createdAt: 1,
  }
  await store.write(OrganizationStoragePath.deployment(), deployment)
  await store.close()
  const upgraded = await open(legacy)
  expect(await upgraded.deployment()).toEqual(deployment)
  const ownership = await Bun.file(path.join(root, "home-ownership.json")).text()
  expect(JSON.parse(ownership)).toMatchObject({ schemaVersion: 1, owner: "organization" })
  await upgraded.close()
  const repeated = await open(legacy)
  expect(await repeated.deployment()).toEqual(deployment)
  expect(await Bun.file(path.join(root, "home-ownership.json")).text()).toBe(ownership)
  await repeated.close()

  const personal = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "organization-personal-"))
  homes.push(personal)
  const privateData = path.join(personal, ".synergy", "data", "storage", "manifest.json")
  await Bun.write(privateData, "personal-data-must-not-change")
  await expect(openOrganizationService({ home: personal })).rejects.toThrow("dedicated Home")
  expect(await Bun.file(privateData).text()).toBe("personal-data-must-not-change")
  expect(await Bun.file(path.join(personal, ".synergy", "data", "organization.sqlite")).exists()).toBe(false)
  expect(await Bun.file(path.join(personal, ".synergy", "home-ownership.json")).exists()).toBe(false)
})
