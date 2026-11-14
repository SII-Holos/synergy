import { expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import path from "node:path"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk"
import {
  OrganizationHandoffProtocol as Handoff,
  OrganizationRuntimeProtocol as Runtime,
} from "@ericsanchezok/synergy-organization-protocol"
import { testResources } from "@ericsanchezok/synergy-testing/resources"
import { WorkspaceCoordinator } from "@ericsanchezok/synergy-local-runtime/workspace/coordinator"
import { prepareMemberHome } from "../src/home"
import { enrollMemberRuntime } from "../src/enrollment"
import { openMemberRuntime } from "../src/runtime"
import { fixture } from "./support/organization"
import { createHandoffCompletion } from "./support/handoff-completion"

async function availablePort() {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = probe.port!
  await probe.stop(true)
  return port
}

test("an explicit native-to-none Environment handoff commits an originally empty organization resource contract without creating resources", async () => {
  await using resources = testResources()
  const service = await fixture()
  resources.defer("organization service", () => service[Symbol.asyncDispose]())
  const options = { headers: service.headers, throwOnError: true as const }
  const coordinator = new WorkspaceCoordinator({ directory: path.join(service.root, "claims") })

  async function member(deviceID: string) {
    const home = await prepareMemberHome({
      baseDirectory: path.join(service.root, "members"),
      identity: { ...service.identity, deviceID },
      origin: service.origin,
    })
    const registration = await enrollMemberRuntime({
      home: home.home,
      identity: home.identity,
      ca: service.ca,
      ticket: await service.ticket(deviceID, home.publicKey),
    })
    const port = await availablePort()
    const token = randomBytes(32).toString("hex")
    const online = Promise.withResolvers<void>()
    const sockets = new Set<unknown>()
    service.interceptFrames((socket, raw) => {
      const frame = Runtime.ClientFrame.parse(JSON.parse(String(raw)))
      if (frame.type === "handshake" && frame.proof.handshake.runtimeID === registration.runtimeID) sockets.add(socket)
      if (frame.type === "heartbeat" && sockets.has(socket)) online.resolve()
      return false
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const runtime = await openMemberRuntime({
        home: home.home,
        identity: home.identity,
        ca: service.ca,
        handoff: true,
        listen: { port, token },
        workspaceCoordinator: coordinator,
      })
      resources.defer(`${deviceID} native Runtime`, () => runtime.close())
      timer = setTimeout(() => online.reject(new Error("The enrolled native Runtime did not connect")), 5000)
      await online.promise
      return {
        registration,
        publicKey: home.publicKey,
        client: createSynergyClient({
          baseUrl: `http://127.0.0.1:${port}`,
          headers: { authorization: `Bearer ${token}` },
        }),
      }
    } finally {
      clearTimeout(timer)
      service.interceptFrames(undefined)
    }
  }

  const source = await member("empty-contract-source")
  const target = await member("empty-contract-target")
  const project = (
    await service.client.orgProjects.create(
      { orgProjectCreate: { name: "Native handoff without cloud resources", description: "" } },
      options,
    )
  ).data
  const created = (
    await service.client.orgSessions.create(
      {
        orgCommandCreateRequest: {
          schemaVersion: 1,
          orgID: service.identity.orgID,
          projectID: project.projectID,
          runtimeID: source.registration.runtimeID,
          requestID: "create-empty-contract",
          creation: { operation: "create", title: "An unchanged native Session" },
        },
      },
      options,
    )
  ).data
  const sessionID = created.effect.sessionID
  const empty = (await service.client.orgSessionResources.get({ sessionID }, options)).data
  expect(empty).toEqual({ sessionID, revision: 0, selection: null })
  const original = (await source.client.session.get({ sessionID, scopeID: project.projectID }, { throwOnError: true }))
    .data
  if (!original.organization) throw new Error("The real source Session has no organization binding")
  const preview = (
    await service.client.orgHandoff.options(
      {
        sessionID,
        targetRuntimeID: target.registration.runtimeID,
        requestID: "inspect-empty-contract-environments",
      },
      options,
    )
  ).data
  if (!preview.environment) throw new Error("The original native participants did not expose their Environment plan")
  expect(preview.environment.source).toMatchObject({ kind: "native", environmentID: original.environmentID })
  expect(preview.environment.expectedSelectionRevision).toBe(0)
  const handoffID = "none-environment-empty-contract"
  const environmentMapping = Handoff.EnvironmentMapping.parse({
    version: 1,
    expectedSelectionRevision: preview.environment.expectedSelectionRevision,
    source: preview.environment.source,
    target: { kind: "none" },
  })
  const environmentMappingHash = await Handoff.environmentMappingHash(environmentMapping)
  const prepared = (
    await service.client.orgHandoff.prepare(
      {
        sessionID,
        orgHandoffPrepare: {
          handoffID,
          targetRuntimeID: target.registration.runtimeID,
          expectedBindingEpoch: preview.bindingEpoch,
          expectedControlRevision: preview.controlRevision,
          mappingPlanRevision: 1,
          workspaceMapping: { kind: "native" },
          environmentMapping,
        },
      },
      options,
    )
  ).data
  await service.client.orgHandoff.accept(
    {
      handoffID,
      orgHandoffAccept: { mappingPlanRevision: prepared.mappingPlanRevision, mappingHash: prepared.mappingHash },
    },
    options,
  )
  const drive = createHandoffCompletion({
    binding: Handoff.Binding.strip().parse(prepared),
    source: { runtimeID: source.registration.runtimeID, publicKey: source.publicKey },
    target: { runtimeID: target.registration.runtimeID, publicKey: target.publicKey },
    async invoke(operation, requestID) {
      return Handoff.MachineResult.parse(
        (await service.client.orgHandoff.drive({ handoffID, orgHandoffDrive: { operation, requestID } }, options)).data,
      )
    },
  })
  const frozen = await drive("prepare-source")
  expect(frozen.facts[0]?.proof).toMatchObject({ purpose: "source-frozen", environmentMappingHash })
  const staged = await drive("prepare-target")
  expect(staged.facts[0]?.proof).toMatchObject({ purpose: "target-prepared", environmentMappingHash })
  await service.client.orgHandoff.permit(
    { handoffID, orgHandoffPermitRequest: { purpose: "handoff-surrender" } },
    options,
  )
  expect((await drive("surrender-source")).facts[0]?.proof.purpose).toBe("source-surrendered")
  const committed = (await service.client.orgHandoff.commit({ handoffID, body: {} }, options)).data
  expect(committed).toMatchObject({ phase: "committed", currentDriver: target.registration.runtimeID, bindingEpoch: 2 })
  expect((await service.client.orgSessionResources.get({ sessionID }, options)).data).toEqual(empty)
  await service.client.orgHandoff.permit(
    { handoffID, orgHandoffPermitRequest: { purpose: "handoff-activation" } },
    options,
  )
  expect((await drive("activate-target")).facts[0]?.proof.purpose).toBe("target-activated")
  const published = (await target.client.session.get({ sessionID, scopeID: project.projectID }, { throwOnError: true }))
    .data
  expect(published).toMatchObject({
    id: sessionID,
    title: original.title,
    environmentID: null,
    paused: expect.anything(),
    organization: { driverRuntimeID: target.registration.runtimeID, bindingEpoch: 2 },
  })
  expect((await service.client.orgSessionResources.get({ sessionID }, options)).data).toEqual(empty)
  expect((await service.client.orgHandoff.get({ handoffID }, options)).data.phase).toBe("completed")
}, 20000)
