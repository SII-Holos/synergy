import { expect, test } from "bun:test"
import path from "node:path"
import {
  OrganizationExecutionProtocol as Execution,
  OrganizationCloudProtocol as Cloud,
  OrganizationRuntimeProtocol as Runtime,
  OrganizationSessionProtocol as SessionProtocol,
} from "@ericsanchezok/synergy-organization-protocol"
import { createOrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { openOrganizationRecovery } from "@ericsanchezok/synergy-organization/service"
import { OrganizationRecord } from "../../../organization/src/storage/records"
import { OrganizationStoragePath } from "../../../organization/src/storage/path"
import { cert, key } from "@ericsanchezok/synergy-testing/organization-tls"
import { resourceFixture } from "../../../organization/test/support/resource-native"
import { recoverResourceFixture } from "../../../organization/test/support/resource-recovery"
import { password } from "../../../organization/test/support/organization"
import { prepareMemberHome } from "../../src/home"
import { enrollMemberRuntime } from "../../src/enrollment"
import { openMemberRuntime } from "../../src/runtime"

async function availablePort() {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = probe.port!
  await probe.stop(true)
  return port
}

async function recoverCloudSession(scenario: "unchanged" | "changed-backed" | "new-native") {
  await using f = await resourceFixture()
  const original = f.source.service.websocket
  const online = Promise.withResolvers<void>()
  let enrolledRuntimeID: string | undefined
  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert, key },
    fetch: f.source.service.fetch,
    websocket: {
      ...original,
      async message(socket, raw) {
        original.message(socket, raw)
        const pending = socket.data.pending
        const frame = Runtime.ClientFrame.parse(JSON.parse(String(raw)))
        if (frame.type !== "handshake") return
        await pending
        if (socket.data.handshake?.runtimeID === enrolledRuntimeID) online.resolve()
        else online.reject(new Error("The original Runtime handshake did not commit"))
      },
    },
  })
  await using listenerCleanup = { [Symbol.asyncDispose]: () => listener.stop(true) }
  const transport = new Bun.FetchSession({ tls: { ca: cert, rejectUnauthorized: true }, proxy: false })
  using transportCleanup = { [Symbol.dispose]: () => transport.close() }
  const client = createOrganizationClient({
    baseUrl: listener.url.origin,
    fetch: Object.assign(transport.fetch, { preconnect() {} }),
    headers: { origin: "https://organization.example" },
  })
  const login = await client.orgAuth.login({ orgLoginInput: { loginName: "owner", password } }, { throwOnError: true })
  const cookie = login.response.headers.get("set-cookie")?.split(";")[0]
  if (!cookie) throw new Error("The original account login did not retain its actual session")
  const options = { headers: { cookie, "x-csrf-token": login.data.csrfToken }, throwOnError: true as const }
  const home = await prepareMemberHome({
    baseDirectory: path.join(f.root, "members"),
    identity: { orgID: f.workspace.orgID, accountID: login.data.account.accountID, deviceID: "resource-history" },
    origin: listener.url.origin,
  })
  const ticket = (
    await client.orgRuntime.registerMember(
      { orgMemberRuntimeRegistration: { deviceID: home.identity.deviceID, publicKey: home.publicKey } },
      options,
    )
  ).data
  const registration = await enrollMemberRuntime({ home: home.home, identity: home.identity, ticket, ca: cert })
  enrolledRuntimeID = registration.runtimeID
  await using runtime = await openMemberRuntime({
    home: home.home,
    identity: home.identity,
    ca: cert,
    listen: { port: await availablePort(), token: "c".repeat(64) },
  })
  await online.promise
  const created = (
    await client.orgSessions.create(
      {
        orgCommandCreateRequest: {
          schemaVersion: 1,
          orgID: home.identity.orgID,
          projectID: f.workspace.projectID,
          runtimeID: registration.runtimeID,
          requestID: "cloud-resource-history-create",
          creation: { operation: "create", title: "Retained resource contract" },
        },
      },
      options,
    )
  ).data
  const sessionID = created.effect.sessionID
  expect((await runtime.run(() => Session.get(sessionID))).id).toBe(sessionID)
  let modelCalls = 0
  using model = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      modelCalls++
      return new Response("Recovery must not start a model", { status: 500 })
    },
  })
  const selectedModel = (
    await client.orgResources.create(
      {
        orgResourceCreate: {
          name: "Never dispatched recovery model",
          scope: { kind: "project", projectID: f.workspace.projectID },
          configuration: {
            protocol: "openai-compatible",
            endpoint: new URL("/v1", model.url).href,
            model: { id: "retained", name: "Retained", limit: { context: 8192, output: 1024 } },
          },
          credential: { kind: "none" },
        },
      },
      options,
    )
  ).data
  await client.orgResourceGrants.set(
    {
      resourceID: selectedModel.resourceID,
      kind: "project",
      subjectID: f.workspace.projectID,
      orgResourceGrantChange: { expectedRevision: 0, enabled: true },
    },
    options,
  )
  const selected = (
    await client.orgSessionResources.set(
      {
        sessionID,
        orgSessionResourceChange: {
          expectedRevision: 0,
          selection: {
            modelResourceID: selectedModel.resourceID,
            connectionResourceIDs: [],
            infrastructure: {
              workspace: { resourceID: f.workspace.resourceID, workspaceID: f.workspace.workspaceID },
              environment: { resourceID: f.environment.resourceID, environmentID: f.environment.environmentID },
            },
          },
        },
      },
      options,
    )
  ).data
  expect(selected.revision).toBe(1)
  const paused = (
    await client.orgCommands.control(
      {
        sessionID,
        orgCommandControlRequest: {
          schemaVersion: 1,
          orgID: home.identity.orgID,
          projectID: f.workspace.projectID,
          runtimeID: registration.runtimeID,
          sessionID,
          requestID: "cloud-resource-history-pause",
          control: { operation: "pause" },
        },
      },
      options,
    )
  ).data
  expect(paused.effect.operation).toBe("pause")
  expect(await runtime.run(async () => SessionManager.isRunning(sessionID))).toBe(false)
  await runtime.close()
  expect(f.allocations).toBe(0)
  expect(modelCalls).toBe(0)
  if (!selected.selection) throw new Error("The original selected contract is incomplete")
  const originalSelection = selected.selection
  const alternativeBytes = Buffer.from("the complete backed alternative Workspace bytes\0\xff")
  async function createAlternativePair() {
    const workspace = (
      await client.orgCloudWorkspaces.create(
        {
          orgCloudWorkspaceCreate: {
            projectID: f.workspace.projectID,
            resourceID: f.workspace.resourceID,
            requestID: "alternative-workspace",
            name: "Alternative original files",
          },
        },
        options,
      )
    ).data
    const saved = (
      await client.orgCloudWorkspaces.write(
        {
          workspaceID: workspace.workspaceID,
          orgCloudWorkspaceWrite: {
            operationID: "alternative-original-bytes",
            expectedRevision: workspace.revision,
            path: "alternative.bin",
            data: alternativeBytes.toString("base64"),
            expectedVersion: null,
          },
        },
        options,
      )
    ).data
    const environment = (
      await client.orgCloudEnvironments.create(
        {
          orgCloudEnvironmentCreate: {
            projectID: f.environment.projectID,
            resourceID: f.environment.resourceID,
            requestID: "alternative-environment",
            name: "Alternative original idle compute",
          },
        },
        options,
      )
    ).data
    expect(environment).toMatchObject({ state: "idle", activeUses: 0 })
    return { workspace: saved, environment }
  }
  let alternative = scenario === "changed-backed" ? await createAlternativePair() : undefined
  let expected = selected
  let h1Changed = false
  const outcome = await recoverResourceFixture(
    f,
    async ({ service, cookie, csrf }) => {
      const request = (route: string) =>
        service.fetch(
          new Request("https://resources-recovered.example/org/v1" + route, {
            headers: { origin: "https://resources-recovered.example", cookie, "x-csrf-token": csrf },
          }),
        )
      const contract = await request(`/sessions/${sessionID}/resources`)
      expect(contract.status).toBe(200)
      expect(Execution.Contract.parse(await contract.json())).toEqual(expected)
      const directory = await request(`/sessions/${sessionID}`)
      expect(directory.status).toBe(200)
      expect(SessionProtocol.View.parse(await directory.json())).toMatchObject({
        sessionID,
        driverRuntimeID: registration.runtimeID,
        bindingEpoch: created.permit.bindingEpoch,
      })
      if (scenario === "changed-backed") {
        if (!alternative) throw new Error("The complete H0 alternative is missing")
        expect(h1Changed).toBe(true)
        const bytes = await service.fetch(
          new Request(
            `https://resources-recovered.example/org/v1/cloud/workspaces/${alternative.workspace.workspaceID}/read`,
            {
              method: "POST",
              headers: {
                origin: "https://resources-recovered.example",
                cookie,
                "x-csrf-token": csrf,
                "content-type": "application/json",
              },
              body: JSON.stringify({ path: "alternative.bin", offset: 0, length: Cloud.chunkBytes }),
            },
          ),
        )
        expect(bytes.status).toBe(200)
        expect(Buffer.from(Cloud.Bytes.parse(await bytes.json()).data, "base64")).toEqual(alternativeBytes)
        const environments = await request(
          `/projects/${f.environment.projectID}/cloud/environments?resourceID=${f.environment.resourceID}&limit=100`,
        )
        expect(environments.status).toBe(200)
        expect(Cloud.EnvironmentPage.parse(await environments.json()).items).toContainEqual(alternative.environment)
      }
      expect(modelCalls).toBe(0)
      expect(f.allocations).toBe(0)
    },
    {
      async afterCheckpoint() {
        if (scenario === "unchanged") return
        if (!alternative) alternative = await createAlternativePair()
        expected = (
          await client.orgSessionResources.set(
            {
              sessionID,
              orgSessionResourceChange: {
                expectedRevision: selected.revision,
                selection: {
                  ...originalSelection,
                  infrastructure: {
                    workspace: {
                      resourceID: alternative.workspace.resourceID,
                      workspaceID: alternative.workspace.workspaceID,
                    },
                    environment: {
                      resourceID: alternative.environment.resourceID,
                      environmentID: alternative.environment.environmentID,
                    },
                  },
                },
              },
            },
            options,
          )
        ).data
        expect(expected.revision).toBe(selected.revision + 1)
        expect((await client.orgSessionResources.get({ sessionID }, options)).data).toEqual(expected)
        h1Changed = true
      },
    },
  ).then(
    () => ({ kind: "resolved" as const }),
    (error: unknown) => ({ kind: "rejected" as const, error }),
  )
  if (scenario !== "new-native") {
    if (outcome.kind === "rejected") throw outcome.error
    return
  }
  if (outcome.kind !== "rejected") throw new Error("Recovery accepted native facts absent from its original H0 facets")
  function failures(error: unknown, depth = 0): unknown[] {
    if (depth > 8) return [error]
    if (error instanceof AggregateError) return error.errors.flatMap((value: unknown) => failures(value, depth + 1))
    if (error instanceof SuppressedError)
      return [...failures(error.error, depth + 1), ...failures(error.suppressed, depth + 1)]
    return [error]
  }
  const blocked = failures(outcome.error).find(
    (error) =>
      error instanceof RuntimeMaintenance.Blocked &&
      /H0 facts differ|incomplete H1 canonical roster/.test(error.data.message),
  )
  if (!blocked) throw outcome.error
  expect(blocked).toBeInstanceOf(RuntimeMaintenance.Blocked)
  expect(h1Changed).toBe(true)
  expect(
    (await Bun.file(path.join(f.source.service.home, ".synergy", "home-ownership.json")).json()).schemaVersion,
  ).toBe(2)
  await using held = await openOrganizationRecovery({ home: path.join(f.root, "target"), cloud: f.targetCloud })
  const retained = await held.run(async () => ({
    maintenance: await RuntimeMaintenance.status(),
    contract: await OrganizationRecord.read(
      OrganizationRecord.SessionResources,
      OrganizationStoragePath.sessionResources(sessionID),
    ),
  }))
  expect(retained.maintenance?.phase).toBe("recovery-held")
  expect(retained.contract).toMatchObject(selected)
  expect(modelCalls).toBe(0)
  expect(f.allocations).toBe(0)
}

test(
  "an ordinary paused Session restores its original cloud resource contract and saved heads without starting execution",
  () => recoverCloudSession("unchanged"),
  30_000,
)
test(
  "current-policy recovery preserves a legitimate H1 selection of complete H0 cloud resources without execution",
  () => recoverCloudSession("changed-backed"),
  30_000,
)
test(
  "an H1 cloud selection with native owners absent from H0 is refused before permanent source retirement",
  () => recoverCloudSession("new-native"),
  30_000,
)
