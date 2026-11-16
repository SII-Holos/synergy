import { expect, test } from "bun:test"
import {
  OrganizationExecutionProtocol as Execution,
  OrganizationCommandProtocol as Command,
  OrganizationGatewayProtocol as Gateway,
  OrganizationResourceProtocol as Resource,
} from "@ericsanchezok/synergy-organization-protocol"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { OrganizationCloud as Cloud } from "../src/cloud"
import { OrganizationResources as Resources } from "../src/resources"
import { OrganizationSessionResources as SessionResources } from "../src/session-resources"
import { OrganizationRecord as Record } from "../src/storage/records"
import { OrganizationStoragePath as Keys } from "../src/storage/path"
import { OrganizationProjects as Projects } from "../src/projects"
import { commandFixture } from "./support/commands"

async function fixture() {
  const f = await commandFixture()
  let allocations = 0
  try {
    const selected = await f.run(async () => {
      Cloud.register({
        blobStores: {
          "selection-files": {
            async put() {
              throw new Error("Selection must not upload files")
            },
            async get() {
              throw new Error("Selection must not download files")
            },
          },
        },
        environmentProviders: [
          {
            id: "selection-compute",
            async allocate() {
              allocations++
              throw new Error("Selection must not allocate")
            },
            async inspect() {
              return { state: "unknown" }
            },
            async deallocate() {
              throw new Error("Selection must not deallocate")
            },
          },
        ],
        workspaceProfiles: { standard: { blobStore: "selection-files" } },
        environmentProfiles: { standard: { provider: "selection-compute", spec: { image: "fixture" } } },
      })
      const model = await Resources.create(
        f.credentials.admin,
        Resource.Create.parse({
          name: "Model",
          scope: { kind: "organization" },
          configuration: {
            protocol: "openai-compatible",
            endpoint: "https://provider.example/v1",
            model: { id: "fixture", name: "Fixture", limit: { context: 32768, output: 4096 } },
          },
          credential: { kind: "bearer", value: "private-model-key" },
        }),
      )
      const connection = await Resources.create(f.credentials.admin, {
        name: "Connection",
        scope: { kind: "organization" },
        configuration: { protocol: "fixed-http", endpoint: "https://business.example/task", method: "POST" },
        credential: { kind: "bearer", value: "private-connection-key" },
      })
      const storage = await Resources.create(f.credentials.admin, {
        name: "Files",
        scope: { kind: "project", projectID: "project" },
        configuration: { protocol: "workspace-storage", profile: "standard" },
        credential: { kind: "none" },
      })
      const compute = await Resources.create(f.credentials.admin, {
        name: "Compute",
        scope: { kind: "project", projectID: "project" },
        configuration: { protocol: "environment", profile: "standard" },
        credential: { kind: "none" },
      })
      for (const resource of [model, connection, storage, compute])
        await Resources.grant(
          f.credentials.admin,
          resource.resourceID,
          { kind: "account", id: "alice" },
          { expectedRevision: 0, enabled: true },
        )
      const workspace = await Cloud.createWorkspace(f.credentials.alice, {
        projectID: "project",
        resourceID: storage.resourceID,
        name: "Execution files",
        requestID: "files",
      })
      const environment = await Cloud.createEnvironment(f.credentials.alice, {
        projectID: "project",
        resourceID: compute.resourceID,
        name: "Execution environment",
        requestID: "compute",
      })
      const selection = Execution.Selection.parse({
        modelResourceID: model.resourceID,
        connectionResourceIDs: [connection.resourceID],
        infrastructure: {
          workspace: { resourceID: storage.resourceID, workspaceID: workspace.workspaceID },
          environment: { resourceID: compute.resourceID, environmentID: environment.environmentID },
        },
      })
      return { selection, model, connection, storage, compute, workspace, environment }
    })
    return { ...f, ...selected, allocations: () => allocations }
  } catch (error) {
    await f[Symbol.asyncDispose]()
    throw error
  }
}

test("one Session resource CAS retains logical infrastructure roles without allocating compute", async () => {
  await using f = await fixture()
  await f.run(async () => {
    const result = await SessionResources.set(f.credentials.alice, f.sessionID, {
      expectedRevision: 0,
      selection: f.selection,
    })
    expect(result).toEqual({ sessionID: f.sessionID, revision: 1, selection: f.selection })
    expect((await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))!.resourceIDs).toEqual(
      Execution.resourceIDs(f.selection),
    )
    expect(await Record.read(Record.SessionResources, Keys.sessionResources(f.sessionID))).toMatchObject({
      schemaVersion: 2,
      selection: f.selection,
    })
    await expect(
      SessionResources.set(f.credentials.alice, f.sessionID, { expectedRevision: 0, selection: f.selection }),
    ).rejects.toMatchObject({ data: { code: "REVISION_CONFLICT" } })
    expect(await Cloud.getEnvironment(f.credentials.alice, f.environment.environmentID)).toMatchObject({
      state: "idle",
      generation: 0,
      activeUses: 0,
    })
    expect(f.allocations()).toBe(0)
  })
})

test("infrastructure selection validates canonical object ownership before publishing the Session CAS", async () => {
  await using f = await fixture()
  await f.run(async () => {
    const other = await Resources.create(f.credentials.admin, {
      name: "Other compute",
      scope: { kind: "organization" },
      configuration: { protocol: "environment", profile: "standard" },
      credential: { kind: "none" },
    })
    await Resources.grant(
      f.credentials.admin,
      other.resourceID,
      { kind: "account", id: "alice" },
      { expectedRevision: 0, enabled: true },
    )
    const foreign = await Cloud.createEnvironment(f.credentials.alice, {
      projectID: "project",
      resourceID: other.resourceID,
      requestID: "other-compute",
      name: "Other owner",
    })
    const project = await Projects.create(f.credentials.admin, { name: "Other project", description: "" })
    await Resources.grant(
      f.credentials.admin,
      other.resourceID,
      { kind: "account", id: "admin" },
      { expectedRevision: 0, enabled: true },
    )
    const otherProject = await Cloud.createEnvironment(f.credentials.admin, {
      projectID: project.projectID,
      resourceID: other.resourceID,
      requestID: "other-project-compute",
      name: "Other project owner",
    })
    for (const infrastructure of [
      {
        ...f.selection.infrastructure,
        environment: { resourceID: f.compute.resourceID, environmentID: foreign.environmentID },
      },
      {
        ...f.selection.infrastructure,
        environment: { resourceID: f.compute.resourceID, environmentID: "missing-environment" },
      },
      {
        ...f.selection.infrastructure,
        workspace: { resourceID: f.storage.resourceID, workspaceID: f.environment.environmentID },
      },
      {
        ...f.selection.infrastructure,
        environment: { resourceID: other.resourceID, environmentID: otherProject.environmentID },
      },
    ]) {
      await expect(
        SessionResources.set(f.credentials.alice, f.sessionID, {
          expectedRevision: 0,
          selection: { ...f.selection, infrastructure },
        }),
      ).rejects.toMatchObject({ data: { code: "RESOURCE_UNAVAILABLE" } })
      expect(await SessionResources.get(f.credentials.alice, f.sessionID)).toMatchObject({
        revision: 0,
        selection: null,
      })
      expect((await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))!.resourceIDs).toEqual([])
    }
    const key = StoragePath.workspace(f.workspace.workspaceID)
    const workspace = await WorkspaceCatalog.get(f.workspace.workspaceID, Cloud.scopeID("org", "project"))
    await Storage.write(key, { ...workspace, backend: { provider: "native", spec: {} } })
    await expect(
      SessionResources.set(f.credentials.alice, f.sessionID, {
        expectedRevision: 0,
        selection: f.selection,
      }),
    ).rejects.toMatchObject({ data: { code: "PROTOCOL_MISMATCH" } })
    expect((await SessionResources.get(f.credentials.alice, f.sessionID)).revision).toBe(0)
    expect(f.allocations()).toBe(0)
  })
})

test("task admission rechecks selected infrastructure rather than trusting its old resource role", async () => {
  await using f = await fixture()
  await f.connect()
  await f.run(async () => {
    await SessionResources.set(f.credentials.alice, f.sessionID, { expectedRevision: 0, selection: f.selection })
    const key = Keys.sessionResources(f.sessionID)
    const selected = (await Record.read(Record.SessionResources, key))!
    await Storage.write(key, {
      ...selected,
      selection: {
        ...selected.selection,
        infrastructure: {
          ...f.selection.infrastructure,
          environment: { resourceID: f.compute.resourceID, environmentID: "missing-environment" },
        },
      },
    })
    const request = f.request()
    request.input.mode = "task"
    await expect(f.commands.input(f.credentials.alice, request)).rejects.toMatchObject({
      data: { code: "RESOURCE_UNAVAILABLE" },
    })
    expect((await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))!.retainedExecutionGrants).toBe(0)
    expect(await Storage.count({ prefix: ["organization", "execution-grants"] })).toBe(0)
    expect(f.allocations()).toBe(0)
  })
})

test("execution descriptions and gateway calls cannot turn infrastructure into business connections", async () => {
  await using f = await fixture()
  await f.connect()
  await f.run(async () => {
    await SessionResources.set(f.credentials.alice, f.sessionID, { expectedRevision: 0, selection: f.selection })
    const input = f.request()
    input.input.mode = "task"
    const admitted = await f.commands.input(f.credentials.alice, input)
    if (admitted.kind !== "admitted") throw new Error("Expected admitted task")
    const permit = admitted.delivery.authorization.permit
    const now = Date.now()
    const receipt = Command.InputResult.parse({
      attempt: { schemaVersion: 1, permit, receivedAt: now, status: "accepted", acceptedAttemptID: permit.attemptID },
      accepted: {
        schemaVersion: 1,
        permit,
        acceptedAt: now,
        intakeSeq: 1,
        effect: { kind: "inbox", mode: "task", itemID: "input", messageID: "root" },
      },
    })
    const proof = Execution.BindingProof.parse({
      schemaVersion: 1,
      purpose: "execution-root-binding",
      orgID: "org",
      deploymentIncarnation: "deployment",
      runtimeID: "runtime-alice",
      connectionEpoch: 1,
      receipt,
      rootID: "root",
      issuedAt: now,
      expiresAt: now + 30_000,
    })
    const grant = await f.execution.bind({
      proof,
      signature: await Execution.signBinding(proof, f.machineKeys.privateKey),
    })
    const { rootID: _, purpose: __, ...received } = proof
    const describe = Execution.DescriptionProof.parse({ ...received, purpose: "execution-resource-description" })
    const description = await f.execution.describe({
      proof: describe,
      signature: await Execution.signDescription(describe, f.machineKeys.privateKey),
    })
    expect(description.grant.selection).toEqual(f.selection)
    expect(description.resources.map((resource) => resource.resourceID)).toEqual([
      f.model.resourceID,
      f.connection.resourceID,
    ])
    expect(JSON.stringify(description)).not.toContain("private-model-key")
    expect(JSON.stringify(description)).not.toContain('"profile"')
    for (const resourceID of [f.storage.resourceID, f.compute.resourceID]) {
      const request = Gateway.Proof.parse({
        schemaVersion: 1,
        purpose: "gateway-call",
        orgID: "org",
        deploymentIncarnation: "deployment",
        runtimeID: "runtime-alice",
        connectionEpoch: 1,
        sessionID: f.sessionID,
        bindingEpoch: 1,
        grantID: grant.grantID,
        rootID: grant.rootID,
        resourceID,
        callID: resourceID,
        issuedAt: now,
        expiresAt: now + 30_000,
      })
      await expect(
        f.gateway.calls.reserve({
          proof: request,
          signature: await Gateway.signRequest(request, f.machineKeys.privateKey),
        }),
      ).rejects.toMatchObject({ data: { code: "PERMISSION_DENIED" } })
    }
    expect(await Storage.count({ prefix: ["organization", "gateway-calls", grant.grantID] })).toBe(0)
    expect(f.allocations()).toBe(0)
  })
})
