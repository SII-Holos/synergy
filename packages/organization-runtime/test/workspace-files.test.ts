import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import { createHash } from "node:crypto"
import {
  OrganizationCloudProtocol as Cloud,
  OrganizationExecutionProtocol as Execution,
  OrganizationRuntimeProtocol,
} from "@ericsanchezok/synergy-organization-protocol"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { RolloutLifecycle } from "@ericsanchezok/synergy-harness/session/rollout/lifecycle"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { testResources } from "@ericsanchezok/synergy-testing/resources"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk"
import { prepareMemberHome } from "../src/home"
import { enrollMemberRuntime } from "../src/enrollment"
import { readCredentials } from "../src/credentials"
import { openMemberRuntime } from "../src/runtime"
import { fixture } from "./support/organization"

async function availablePort() {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = probe.port!
  await probe.stop(true)
  return port
}

async function sharedFilesFixture() {
  const resources = testResources()
  try {
    const temporary = await tmpdir()
    resources.defer("shared files directory", () => temporary[Symbol.asyncDispose]())
    let allocations = 0
    let beforePut: (() => Promise<void>) | undefined
    const service = await fixture({
      cloud: {
        blobStores: {
          shared: {
            async put(hash, bytes) {
              await beforePut?.()
              await Bun.write(path.join(temporary.path, hash), bytes)
            },
            get: (hash) => Bun.file(path.join(temporary.path, hash)).bytes(),
          },
        },
        workspaceProfiles: { standard: { blobStore: "shared" } },
        environmentProviders: [
          {
            id: "unused-compute",
            async allocate() {
              allocations++
              throw new Error("Files must not allocate compute")
            },
            async inspect() {
              return { state: "unknown" }
            },
            async deallocate() {},
          },
        ],
      },
    })
    resources.defer("organization service", () => service[Symbol.asyncDispose]())
    const wake = spyOn(SessionManager, "scheduleWake").mockImplementation(() => {})
    resources.defer("member wakes", () => wake.mockRestore())
    const options = { headers: service.headers, throwOnError: true as const }
    const project = (
      await service.client.orgProjects.create({ orgProjectCreate: { name: "Shared files", description: "" } }, options)
    ).data
    const model = (
      await service.client.orgResources.create(
        {
          orgResourceCreate: {
            name: "Unused model",
            scope: { kind: "project", projectID: project.projectID },
            configuration: {
              protocol: "openai-compatible",
              endpoint: "https://provider.example/v1",
              model: { id: "fixture", name: "Fixture", limit: { context: 8192, output: 1024 } },
            },
            credential: { kind: "none" },
          },
        },
        options,
      )
    ).data
    const resource = (
      await service.client.orgResources.create(
        {
          orgResourceCreate: {
            name: "Shared object files",
            scope: { kind: "project", projectID: project.projectID },
            configuration: { protocol: "workspace-storage", profile: "standard" },
            credential: { kind: "none" },
          },
        },
        options,
      )
    ).data
    for (const selected of [model, resource])
      await service.client.orgResourceGrants.set(
        {
          resourceID: selected.resourceID,
          kind: "account",
          subjectID: service.identity.accountID,
          orgResourceGrantChange: { expectedRevision: 0, enabled: true },
        },
        options,
      )
    const cloud = (
      await service.client.orgCloudWorkspaces.create(
        {
          orgCloudWorkspaceCreate: {
            projectID: project.projectID,
            resourceID: resource.resourceID,
            requestID: "create-shared-files",
            name: "Shared files",
          },
        },
        options,
      )
    ).data

    async function member(deviceID: string, token: string) {
      const home = await prepareMemberHome({
        baseDirectory: path.join(service.root, "members"),
        identity: { ...service.identity, deviceID },
        origin: service.origin,
      })
      const registration = await enrollMemberRuntime({
        home: home.home,
        identity: home.identity,
        ticket: await service.ticket(deviceID, home.publicKey),
        ca: service.ca,
      })
      let online = Promise.withResolvers<void>()
      const sockets = new Set<unknown>()
      service.interceptFrames((socket, raw) => {
        const frame = OrganizationRuntimeProtocol.ClientFrame.parse(JSON.parse(String(raw)))
        if (frame.type === "handshake" && frame.proof.handshake.runtimeID === registration.runtimeID)
          sockets.add(socket)
        if (frame.type === "heartbeat" && sockets.has(socket)) online.resolve()
        return false
      })
      const port = await availablePort()
      let runtime = await openMemberRuntime({
        home: home.home,
        identity: home.identity,
        ca: service.ca,
        listen: { port, token },
      })
      resources.defer("member Runtime", () => runtime.close())
      const timeout = setTimeout(() => online.reject(new Error("Member did not connect")), 5000)
      try {
        await online.promise
      } finally {
        clearTimeout(timeout)
      }
      const created = (
        await service.client.orgSessions.create(
          {
            orgCommandCreateRequest: {
              schemaVersion: 1,
              orgID: service.identity.orgID,
              projectID: project.projectID,
              runtimeID: registration.runtimeID,
              requestID: "create-" + deviceID,
              creation: { operation: "create" },
            },
          },
          options,
        )
      ).data
      const sessionID = created.effect.sessionID
      await service.client.orgSessionResources.set(
        {
          sessionID,
          orgSessionResourceChange: {
            expectedRevision: 0,
            selection: {
              modelResourceID: model.resourceID,
              connectionResourceIDs: [],
              infrastructure: {
                workspace: { resourceID: resource.resourceID, workspaceID: cloud.workspaceID },
                environment: null,
              },
            },
          },
        },
        options,
      )
      await service.client.orgCommands.input(
        {
          sessionID,
          orgCommandInputRequest: {
            schemaVersion: 1,
            orgID: service.identity.orgID,
            requestID: "task-" + deviceID,
            sessionID,
            projectID: project.projectID,
            runtimeID: registration.runtimeID,
            input: { operation: "input", mode: "task", parts: [{ type: "text", text: "Use the shared files" }] },
          },
        },
        options,
      )
      await runtime.run(async () => {
        const session = await Session.get(sessionID)
        await ScopeContext.provide({
          scope: session.scope,
          workspace: null,
          fn: async () => {
            await Session.update(sessionID, (draft) => {
              draft.modelOverride = { providerID: "test", modelID: "test" }
            })
            const item = (await SessionInbox.list(sessionID))[0]!
            expect((await SessionInbox.materializeNextTask(sessionID)).status).toBe("materialized")
            await RolloutLedger.beginRun(RolloutLifecycle.owner(session), item.messageID)
          },
        })
      })
      const client = createSynergyClient({
        baseUrl: `http://127.0.0.1:${port}`,
        headers: { authorization: `Bearer ${token}` },
      })
      const credentials = (await readCredentials(home.root))!
      return {
        get runtime() {
          return runtime
        },
        sessionID,
        key: credentials.privateKey,
        async reopen() {
          await runtime.close()
          online = Promise.withResolvers<void>()
          service.interceptFrames((socket, raw) => {
            const frame = OrganizationRuntimeProtocol.ClientFrame.parse(JSON.parse(String(raw)))
            if (frame.type === "handshake" && frame.proof.handshake.runtimeID === registration.runtimeID)
              sockets.add(socket)
            if (frame.type === "heartbeat" && sockets.has(socket)) online.resolve()
            return false
          })
          runtime = await openMemberRuntime({
            home: home.home,
            identity: home.identity,
            ca: service.ca,
            listen: { port, token },
          })
          const timeout = setTimeout(() => online.reject(new Error("Member did not reconnect")), 5000)
          try {
            await online.promise
          } finally {
            clearTimeout(timeout)
            service.interceptFrames(undefined)
          }
        },
        async request(body: Cloud.LocalFileRequest) {
          const result = await client.orgLocalWorkspaceFiles.request({ sessionID, orgCloudLocalFileRequest: body })
          return { status: result.response.status, json: async () => result.data ?? result.error }
        },
      }
    }
    return {
      ...service,
      member,
      resource,
      allocations: () => allocations,
      beforePut(value: typeof beforePut) {
        beforePut = value
      },
      [Symbol.asyncDispose]: resources.close,
    }
  } catch (error) {
    await resources.close()
    throw error
  }
}

test("two enrolled member file APIs share one remote Workspace head and retain original CAS receipts", async () => {
  await using f = await sharedFilesFixture()
  const { member } = f
  const alice = await member("files-a", "a".repeat(64))
  const bob = await member("files-b", "b".repeat(64))
  f.interceptFrames(undefined)
  const first = await alice.request({ operation: { action: "describe" } })
  expect(first.status).toBe(200)
  const a = Cloud.FileResult.parse(await first.json())
  const bResponse = await bob.request({ operation: { action: "describe" } })
  expect(bResponse.status).toBe(200)
  const b = Cloud.FileResult.parse(await bResponse.json())
  expect(a.reference).toEqual(b.reference)
  const write = {
    reference: a.reference,
    operation: {
      action: "write",
      id: "write-once",
      path: "shared.bin",
      data: Buffer.from([0, 255, 37, 128]).toString("base64"),
      expectedVersion: null,
    },
  } satisfies Cloud.LocalFileRequest
  const saved = await alice.request(write)
  expect(saved.status).toBe(200)
  const receipt = Cloud.FileResult.parse(await saved.json())
  const seen = await bob.request({
    reference: b.reference,
    operation: { action: "read", path: "shared.bin", offset: 0, maximumBytes: 4 },
  })
  expect(seen.status).toBe(200)
  expect(Cloud.FileResult.parse(await seen.json()).result).toMatchObject({ action: "read", data: write.operation.data })
  f.interceptHTTP(async (request) => {
    if (!request.url.endsWith("/workspaces/files")) return
    const value = Cloud.FileResult.parse(await (await f.service.fetch(request)).json())
    if (value.result.action === "read") value.result.data = "AA=="
    return Response.json(value)
  })
  expect(
    (
      await bob.request({
        reference: b.reference,
        operation: { action: "read", path: "shared.bin", offset: 0, maximumBytes: 4 },
      })
    ).status,
  ).toBe(503)
  f.interceptHTTP(undefined)
  const read = Cloud.FileResult.parse(await seen.json()).result
  if (read.action !== "read") throw new Error("Expected original binary read")
  f.interceptHTTP(async (request) => {
    if (!request.url.endsWith("/workspaces/files")) return
    const value = Cloud.FileResult.parse(await (await f.service.fetch(request)).json())
    if (value.result.action === "read") value.result.version = "sha256:" + "0".repeat(64)
    return Response.json(value)
  })
  expect(
    (
      await bob.request({
        reference: b.reference,
        operation: { action: "read", path: "shared.bin", offset: 0, maximumBytes: 4, expectedVersion: read.version },
      })
    ).status,
  ).toBe(503)
  f.interceptHTTP(undefined)
  expect(
    (await bob.request({ ...write, reference: b.reference, operation: { ...write.operation, id: "stale-other" } }))
      .status,
  ).toBe(409)
  expect(Cloud.FileResult.parse(await (await alice.request(write)).json())).toEqual(receipt)
  expect((await alice.request({ ...write, operation: { ...write.operation, data: "YWx0ZXJlZA==" } })).status).toBe(409)
  expect(
    (
      await alice.request({
        ...write,
        reference: { ...receipt.reference, generation: receipt.reference.generation + 1 },
      })
    ).status,
  ).toBe(409)
  expect(
    (await alice.request({ ...write, reference: { ...receipt.reference, resourceID: "another-resource" } })).status,
  ).toBe(403)
  const publish = async (operation: Cloud.FileOperation) => {
    const reference = Cloud.FileResult.parse(
      await (await alice.request({ operation: { action: "describe" } })).json(),
    ).reference
    const response = await alice.request({ reference, operation })
    expect(response.status).toBe(200)
    return Cloud.FileResult.parse(await response.json())
  }
  await publish({ action: "mutate", id: "directory", change: { kind: "mkdir", path: "a" } })
  await publish({ action: "write", id: "nested", path: "a/x", data: "eA==", expectedVersion: null })
  await publish({ action: "write", id: "sibling", path: "a.txt", data: "eA==", expectedVersion: null })
  const current = Cloud.FileResult.parse(
    await (await bob.request({ operation: { action: "describe" } })).json(),
  ).reference
  const page1 = Cloud.FileResult.parse(
    await (await bob.request({ reference: current, operation: { action: "list", path: "", limit: 1 } })).json(),
  )
  expect(page1.result).toMatchObject({ action: "list", items: [{ path: "a" }], cursor: "a" })
  if (page1.result.action !== "list") throw new Error("Expected directory page")
  const page2 = Cloud.FileResult.parse(
    await (
      await bob.request({
        reference: current,
        operation: { action: "list", path: "", limit: 1, cursor: page1.result.cursor, revision: page1.result.revision },
      })
    ).json(),
  )
  expect(page2.result).toMatchObject({ action: "list", items: [{ path: "a.txt" }] })
  await publish({
    action: "mutate",
    id: "literal-link",
    change: { kind: "replace", path: "a/link", data: "eA==", mode: "120000", expectedVersion: null },
  })
  const aStat = Cloud.FileResult.parse(
    await (await alice.request({ reference: current, operation: { action: "stat", path: "a" } })).json(),
  )
  if (aStat.result.action !== "stat" || !aStat.result.item) throw new Error("Expected directory metadata")
  await publish({
    action: "mutate",
    id: "relocate",
    change: { kind: "move", from: "a", to: "moved", expectedVersion: aStat.result.item.entryVersion },
  })
  expect(
    (
      await bob.request({
        reference: current,
        operation: { action: "list", path: "", limit: 1, cursor: page1.result.cursor, revision: page1.result.revision },
      })
    ).status,
  ).toBe(409)
  const linked = await bob.request({
    reference: current,
    operation: { action: "read", path: "moved/link", offset: 0, maximumBytes: 1 },
  })
  expect(Cloud.FileResult.parse(await linked.json()).result).toMatchObject({ action: "read", data: "eA==" })
  const readOnly = await publish({
    action: "write",
    id: "readonly",
    path: "locked",
    data: "eA==",
    mode: 0o444,
    expectedVersion: null,
  })
  expect(
    (
      await bob.request({
        reference: readOnly.reference,
        operation: {
          action: "write",
          id: "deny-readonly",
          path: "locked",
          data: "eQ==",
          expectedVersion: "sha256:" + createHash("sha256").update("x").digest("hex"),
        },
      })
    ).status,
  ).toBe(403)
  expect(
    (
      await bob.request({
        reference: readOnly.reference,
        operation: {
          action: "write",
          id: "sensitive",
          path: ".env",
          data: "eA==",
          expectedVersion: null,
          protectSensitive: true,
        },
      })
    ).status,
  ).toBe(403)

  f.interceptHTTP(async (request) => {
    if (!request.url.endsWith("/workspaces/files")) return
    const value = Cloud.FileRequest.parse(await request.clone().json())
    if (value.proof.operation.action !== "write" || value.proof.operation.id !== "lost-ack") return
    expect((await f.service.fetch(request)).status).toBe(200)
    return Response.json(
      { code: "SERVICE_UNAVAILABLE", message: "Write response lost", outcome: "unknown", retryable: true },
      { status: 503 },
    )
  })
  const uncertain = {
    reference: readOnly.reference,
    operation: { action: "write", id: "lost-ack", path: "uncertain", data: "eQ==", expectedVersion: null },
  } satisfies Cloud.LocalFileRequest
  expect((await alice.request(uncertain)).status).toBe(503)
  f.interceptHTTP(undefined)
  await alice.reopen()
  const inspected = Cloud.FileResult.parse(
    await (
      await alice.request({ reference: uncertain.reference, operation: { action: "receipt", id: "lost-ack" } })
    ).json(),
  )
  expect(inspected.result).toMatchObject({ action: "receipt", status: { state: "saved", id: "lost-ack" } })
  const recovered = Cloud.FileResult.parse(await (await alice.request(uncertain)).json())
  expect(recovered.result).toMatchObject({ action: "write", checkpoint: { id: "lost-ack" } })
  expect(recovered.reference.revision).toBe(readOnly.reference.revision + 1)

  f.interceptHTTP(async (request) => {
    if (!request.url.endsWith("/workspaces/files")) return
    const value = Cloud.FileRequest.parse(await request.clone().json())
    value.proof.operation = {
      action: "write",
      id: "unsigned-alteration",
      path: "forged",
      data: "eA==",
      expectedVersion: null,
    }
    return f.service.fetch(new Request(request, { body: JSON.stringify(value) }))
  })
  expect(
    (await bob.request({ reference: recovered.reference, operation: { action: "stat", path: "forged" } })).status,
  ).toBe(403)
  f.interceptHTTP(undefined)
  const forged = Cloud.FileResult.parse(
    await (await bob.request({ reference: recovered.reference, operation: { action: "stat", path: "forged" } })).json(),
  )
  expect(forged.result).toEqual({ action: "stat" })
  f.interceptHTTP(async (request) => {
    if (!request.url.endsWith("/workspaces/files")) return
    const value = Cloud.FileResult.parse(await (await f.service.fetch(request)).json())
    if (value.result.action === "write") value.result.checkpoint.mount.workspaceID = "another-workspace"
    return Response.json(value)
  })
  const malformed = {
    reference: recovered.reference,
    operation: { action: "write", id: "bad-checkpoint", path: "bad-reply", data: "eA==", expectedVersion: null },
  } satisfies Cloud.LocalFileRequest
  expect((await alice.request(malformed)).status).toBe(503)
  f.interceptHTTP(undefined)
  expect(
    Cloud.FileResult.parse(
      await (
        await alice.request({ reference: malformed.reference, operation: { action: "receipt", id: "bad-checkpoint" } })
      ).json(),
    ).result,
  ).toMatchObject({ action: "receipt", status: { state: "saved", checkpoint: { id: "bad-checkpoint" } } })
  f.interceptHTTP(async (request) => {
    if (!request.url.endsWith("/workspaces/files")) return
    const value = Cloud.FileResult.parse(await (await f.service.fetch(request)).json())
    if (value.result.action === "receipt" && value.result.status) value.result.status.id = "another-operation"
    if (value.result.action === "acknowledge") value.result.id = "another-operation"
    return Response.json(value)
  })
  for (const action of ["receipt", "acknowledge"] as const)
    expect(
      (await alice.request({ reference: malformed.reference, operation: { action, id: "bad-checkpoint" } })).status,
    ).toBe(503)
  f.interceptHTTP(undefined)
  for (const client of [alice, bob])
    await client.runtime.run(async () => {
      expect((await Session.get(client.sessionID)).workspaceID).toBeNull()
      expect(await Storage.count({ prefix: ["workspace"] })).toBe(0)
    })
  expect(f.allocations()).toBe(0)
}, 30_000)

test("accepted physical file work blocks grant release and rechecks resource disablement before publication", async () => {
  await using f = await sharedFilesFixture()
  const alice = await f.member("files-held", "c".repeat(64))
  f.interceptFrames(undefined)
  const reference = Cloud.FileResult.parse(
    await (await alice.request({ operation: { action: "describe" } })).json(),
  ).reference
  let accepted: Cloud.FileRequest | undefined
  f.interceptHTTP(async (request) => {
    if (request.url.endsWith("/workspaces/files")) accepted = Cloud.FileRequest.parse(await request.clone().json())
  })
  const entered = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  f.beforePut(async () => {
    entered.resolve()
    await resume.promise
  })
  const pending = alice.request({
    reference,
    operation: { action: "write", id: "revoked-during-put", path: "rejected", data: "eA==", expectedVersion: null },
  })
  try {
    await entered.promise
    const proof = Execution.ReleaseProof.parse({
      ...accepted!.proof.authority.proof,
      purpose: "execution-resources-release",
      generation: 1,
      outcome: "completed",
    })
    const release = { proof, signature: await Execution.signRelease(proof, alice.key) }
    const held = await f.client.orgExecution.release(
      { orgExecutionReleaseRequest: release },
      { headers: { origin: "" } },
    )
    expect(held.error).toMatchObject({ code: "RESOURCE_UNAVAILABLE" })
    expect(held.response.status).toBe(409)
    await f.client.orgResources.update(
      { resourceID: f.resource.resourceID, orgResourceChange: { expectedRevision: 1, state: "disabled" } },
      { headers: f.headers, throwOnError: true },
    )
  } finally {
    f.beforePut(undefined)
    resume.resolve()
  }
  expect((await pending).status).toBe(503)
  f.interceptHTTP(undefined)
  await f.client.orgResources.update(
    { resourceID: f.resource.resourceID, orgResourceChange: { expectedRevision: 2, state: "enabled" } },
    { headers: f.headers, throwOnError: true },
  )
  const after = Cloud.FileResult.parse(await (await alice.request({ operation: { action: "describe" } })).json())
  expect(after.reference).toEqual(reference)
  const receipt = Cloud.FileResult.parse(
    await (await alice.request({ reference, operation: { action: "receipt", id: "revoked-during-put" } })).json(),
  )
  expect(receipt.result).toEqual({ action: "receipt" })
  expect(
    (await alice.request({ reference, operation: { action: "read", path: "rejected", offset: 0, maximumBytes: 1 } }))
      .status,
  ).toBe(404)
  const permit = accepted!.proof.authority.proof.receipt.accepted!.permit
  const operationID =
    "file_" +
    createHash("sha256")
      .update(
        JSON.stringify([
          permit.orgID,
          permit.projectID,
          permit.sessionID,
          permit.runtimeID,
          permit.bindingEpoch,
          permit.admissionID,
          permit.attemptID,
          accepted!.proof.authority.proof.rootID,
          "purpose-isolated",
        ]),
      )
      .digest("hex")
  const browser = {
    operationID,
    expectedRevision: reference.revision,
    path: "browser-write",
    data: "eQ==",
    expectedVersion: null,
  }
  const published = (
    await f.client.orgCloudWorkspaces.write(
      { workspaceID: reference.workspaceID, orgCloudWorkspaceWrite: browser },
      { headers: f.headers, throwOnError: true },
    )
  ).data
  const isolated = await alice.request({ reference, operation: { action: "receipt", id: "purpose-isolated" } })
  expect(isolated.status).toBe(200)
  expect(Cloud.FileResult.parse(await isolated.json()).result).toEqual({ action: "receipt" })
  expect(
    (
      await f.client.orgCloudWorkspaces.write(
        { workspaceID: reference.workspaceID, orgCloudWorkspaceWrite: browser },
        { headers: f.headers, throwOnError: true },
      )
    ).data,
  ).toEqual(published)
  expect(f.allocations()).toBe(0)
}, 30_000)

test("a final actual transaction guard rolls back the cloud head and file receipt together", async () => {
  await using f = await sharedFilesFixture()
  const alice = await f.member("files-rollback", "d".repeat(64))
  f.interceptFrames(undefined)
  const reference = Cloud.FileResult.parse(
    await (await alice.request({ operation: { action: "describe" } })).json(),
  ).reference
  const original = Storage.write
  let guarded = false
  using write = spyOn(Storage, "write").mockImplementation(async (key, value) => {
    await original(key, value)
    if (key[0] !== "organization" || key[1] !== "cloud" || key[2] !== "receipts") return
    guarded = true
    await Storage.transaction(async () => {}, {
      commitGuard() {
        throw new Error("Final cloud commit rejected")
      },
    })
  })
  expect(
    (
      await alice.request({
        reference,
        operation: { action: "write", id: "atomic-receipt", path: "rolled-back", data: "eA==", expectedVersion: null },
      })
    ).status,
  ).toBeGreaterThanOrEqual(500)
  expect(guarded).toBeTrue()
  write.mockRestore()
  expect(
    Cloud.FileResult.parse(await (await alice.request({ operation: { action: "describe" } })).json()).reference,
  ).toEqual(reference)
  expect(
    Cloud.FileResult.parse(
      await (await alice.request({ reference, operation: { action: "receipt", id: "atomic-receipt" } })).json(),
    ).result,
  ).toEqual({ action: "receipt" })
  expect(
    (await alice.request({ reference, operation: { action: "read", path: "rolled-back", offset: 0, maximumBytes: 1 } }))
      .status,
  ).toBe(404)
}, 30_000)
