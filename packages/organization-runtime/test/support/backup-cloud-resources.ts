import { expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceContent, WorkspaceBlobs } from "@ericsanchezok/synergy-harness/workspace/content"
import {
  OrganizationCloudProtocol as Cloud,
  OrganizationExecutionProtocol as Execution,
} from "@ericsanchezok/synergy-organization-protocol"
import type { openOrganizationService } from "@ericsanchezok/synergy-organization/service"
import { resourcePorts } from "../../../organization/test/support/resource-native-ports"
import type { fixture } from "./organization"
import type { completedHostedTask } from "./hosted-task"
import { verifyHostedPauseHistory } from "./hosted-pause-history"

type ServiceFixture = Awaited<ReturnType<typeof fixture>>
type HostedTask = Awaited<ReturnType<typeof completedHostedTask>>

async function selectCloudResources(service: ServiceFixture, task: HostedTask) {
  const options = { headers: service.headers, throwOnError: true as const }
  const projectID = task.target.projectID
  const resource = async (
    name: string,
    configuration: { protocol: "workspace-storage"; profile: string } | { protocol: "environment"; profile: string },
  ) => {
    const created = (
      await service.client.orgResources.create(
        {
          orgResourceCreate: {
            name,
            scope: { kind: "project", projectID },
            configuration,
            credential: { kind: "none" },
          },
        },
        options,
      )
    ).data
    await service.client.orgResourceGrants.set(
      {
        resourceID: created.resourceID,
        kind: "project",
        subjectID: projectID,
        orgResourceGrantChange: { expectedRevision: 0, enabled: true },
      },
      options,
    )
    return created
  }
  const files = await resource("Hosted recovery files", { protocol: "workspace-storage", profile: "files" })
  const compute = await resource("Hosted recovery compute", { protocol: "environment", profile: "compute" })
  const workspace = (
    await service.client.orgCloudWorkspaces.create(
      {
        orgCloudWorkspaceCreate: {
          projectID,
          resourceID: files.resourceID,
          requestID: "hosted-recovery-files",
          name: "Original Hosted files",
        },
      },
      options,
    )
  ).data
  const versions = [
    Buffer.from("Hosted original object bytes\0\u00ff"),
    Buffer.from("Hosted current object bytes\0\u00ff"),
  ]
  let current = workspace
  let expectedVersion: string | null = null
  for (const [index, bytes] of versions.entries()) {
    current = (
      await service.client.orgCloudWorkspaces.write(
        {
          workspaceID: workspace.workspaceID,
          orgCloudWorkspaceWrite: {
            operationID: "hosted-object-version-" + index,
            expectedRevision: current.revision,
            path: "data.bin",
            expectedVersion,
            data: bytes.toString("base64"),
          },
        },
        options,
      )
    ).data
    const read = (
      await service.client.orgCloudWorkspaces.read(
        {
          workspaceID: workspace.workspaceID,
          orgCloudWorkspaceRead: { path: "data.bin", offset: 0, length: Cloud.chunkBytes },
        },
        options,
      )
    ).data
    expect(Buffer.from(read.data, "base64")).toEqual(bytes)
    expectedVersion = read.version
  }
  const environment = (
    await service.client.orgCloudEnvironments.create(
      {
        orgCloudEnvironmentCreate: {
          projectID,
          resourceID: compute.resourceID,
          requestID: "hosted-recovery-compute",
          name: "Original idle Hosted compute",
        },
      },
      options,
    )
  ).data
  expect(environment).toMatchObject({ state: "idle", activeUses: 0 })
  const previous = Execution.Contract.parse(
    (await service.client.orgSessionResources.get({ sessionID: task.sessionID }, options)).data,
  )
  if (!previous.selection) throw new Error("The original completed Hosted task has no resource contract")
  expect(previous.selection.modelResourceID).toBe(task.model.resourceID)
  const contract = Execution.Contract.parse(
    (
      await service.client.orgSessionResources.set(
        {
          sessionID: task.sessionID,
          orgSessionResourceChange: {
            expectedRevision: previous.revision,
            selection: {
              ...previous.selection,
              infrastructure: {
                workspace: { resourceID: files.resourceID, workspaceID: workspace.workspaceID },
                environment: { resourceID: compute.resourceID, environmentID: environment.environmentID },
              },
            },
          },
        },
        options,
      )
    ).data,
  )
  expect(contract.revision).toBe(previous.revision + 1)
  expect(contract.selection?.infrastructure).toEqual({
    workspace: { resourceID: files.resourceID, workspaceID: workspace.workspaceID },
    environment: { resourceID: compute.resourceID, environmentID: environment.environmentID },
  })
  const paused = (
    await service.client.orgCommands.control(
      {
        sessionID: task.sessionID,
        orgCommandControlRequest: {
          ...task.target,
          sessionID: task.sessionID,
          requestID: "pause-selected-cloud-before-backup",
          control: { operation: "pause" },
        },
      },
      options,
    )
  ).data
  expect(paused.effect.operation).toBe("pause")
  await verifyHostedPauseHistory(service, task, paused)
  return { contract, workspace: current, environment, versions }
}

async function verifyRestoredCloud(
  source: ServiceFixture,
  restored: Awaited<ReturnType<typeof openOrganizationService>>,
  expected: Awaited<ReturnType<typeof selectCloudResources>>,
) {
  const login = await source.client.orgAuth.login(
    { orgLoginInput: { loginName: "owner", password: "a long integration password" } },
    { throwOnError: true },
  )
  const cookie = login.response.headers.get("set-cookie")?.split(";")[0]
  if (!cookie) throw new Error("Restored cloud history did not issue its actual current owner login")
  const options = { headers: { cookie, "x-csrf-token": login.data.csrfToken }, throwOnError: true as const }
  expect(
    Execution.Contract.parse(
      (await source.client.orgSessionResources.get({ sessionID: expected.contract.sessionID }, options)).data,
    ),
  ).toEqual(expected.contract)
  expect(
    (await source.client.orgCloudWorkspaces.get({ workspaceID: expected.workspace.workspaceID }, options)).data,
  ).toEqual(expected.workspace)
  const read = (
    await source.client.orgCloudWorkspaces.read(
      {
        workspaceID: expected.workspace.workspaceID,
        orgCloudWorkspaceRead: { path: "data.bin", offset: 0, length: Cloud.chunkBytes },
      },
      options,
    )
  ).data
  expect(Buffer.from(read.data, "base64")).toEqual(expected.versions[1]!)
  expect(
    (await source.client.orgCloudEnvironments.get({ environmentID: expected.environment.environmentID }, options)).data,
  ).toMatchObject({ ...expected.environment, state: "idle", activeUses: 0 })
  await restored.maintenance.run(async () => {
    const [info] = await WorkspaceCatalog.readMany([expected.workspace.workspaceID])
    if (!info) throw new Error("The restored cloud Workspace lost its original native owner")
    const spec = WorkspaceContent.Spec.parse(info.backend?.spec)
    const store = WorkspaceBlobs.get(spec.blobStore, spec.settings)
    for (const [index, bytes] of expected.versions.entries()) {
      const [raw] = await Storage.readMany([["workspace_content", info.id, String(index + 1)]])
      const content = WorkspaceCatalog.Content.parse(raw)
      await WorkspaceContent.withTree({ ...info, content }, store, async (tree) => {
        const chunks: Uint8Array[] = []
        for await (const chunk of tree.read("data.bin")) chunks.push(chunk)
        expect(Buffer.concat(chunks)).toEqual(bytes)
      })
    }
    const environment = await Environment.get(expected.environment.environmentID, info.scopeID)
    expect(environment.state).toBe("idle")
    expect(environment.allocation).toBeUndefined()
    expect(await Environment.uses(environment.id)).toEqual([])
  })
}

export async function hostedCloudResourceFixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "hosted-cloud-recovery-")))
  try {
    const original = path.join(root, "source-objects"),
      received = path.join(root, "target-objects")
    await Promise.all([fs.mkdir(original), fs.mkdir(received)])
    const ports = resourcePorts(original, received)
    return {
      sourceCloud: ports.sourceCloud,
      targetCloud: ports.targetCloud,
      async select(service: ServiceFixture, task: HostedTask) {
        const selected = await selectCloudResources(service, task)
        expect(ports.allocations).toBe(0)
        return selected
      },
      async verify(
        service: ServiceFixture,
        restored: Awaited<ReturnType<typeof openOrganizationService>>,
        selected: Awaited<ReturnType<typeof selectCloudResources>>,
      ) {
        await verifyRestoredCloud(service, restored, selected)
        expect(ports.allocations).toBe(0)
      },
      async removeOriginalObjects() {
        await fs.rm(original, { recursive: true })
      },
      async [Symbol.asyncDispose]() {
        await fs.rm(root, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true })
    throw error
  }
}
