import {
  OrganizationCloudExecutionProtocol as Environment,
  OrganizationCloudProtocol as Cloud,
  OrganizationCommandProtocol as Command,
  OrganizationExecutionProtocol as Execution,
  OrganizationResourceProtocol as Resource,
} from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationCloud, type OrganizationCloudOptions } from "../../src/cloud"
import { OrganizationResources } from "../../src/resources"
import { OrganizationSessionResources } from "../../src/session-resources"
import { commandFixture } from "./commands"

export async function selectedEnvironmentTask(options: { cloud?: OrganizationCloudOptions; register?(): void } = {}) {
  const f = await commandFixture()
  try {
    await f.connect()
    const selection = await f.run(async () => {
      const blobs = new Map<string, Uint8Array>()
      OrganizationCloud.register(
        options.cloud ?? {
          blobStores: {
            authority: {
              async put(hash, bytes) {
                blobs.set(hash, bytes.slice())
              },
              async get(hash) {
                const bytes = blobs.get(hash)
                if (!bytes) throw new Error("Missing original object")
                return bytes.slice()
              },
            },
          },
          workspaceProfiles: { authority: { blobStore: "authority" } },
          environmentProviders: [
            {
              id: "authority",
              async allocate() {
                throw new Error("Authority reads cannot allocate compute")
              },
              async inspect() {
                return { state: "unknown" }
              },
              async deallocate() {
                throw new Error("Authority reads cannot retire compute")
              },
            },
          ],
          environmentProfiles: { authority: { provider: "authority", spec: {} } },
        },
      )
      options.register?.()
      async function resource(name: string, configuration: Resource.Configuration) {
        const value = await OrganizationResources.create(f.credentials.admin, {
          name,
          scope: { kind: "project", projectID: "project" },
          configuration,
          credential: { kind: "none" },
        })
        await OrganizationResources.grant(
          f.credentials.admin,
          value.resourceID,
          { kind: "project", id: "project" },
          { expectedRevision: 0, enabled: true },
        )
        return value
      }
      const model = await resource("Model", {
        protocol: "openai-compatible",
        endpoint: "https://provider.example/v1",
        model: Resource.Model.parse({ id: "fixture", name: "Fixture", limit: { context: 32768, output: 4096 } }),
      })
      const files = await resource("Files", { protocol: "workspace-storage", profile: "authority" })
      const compute = await resource("Execution", { protocol: "environment", profile: "authority" })
      const workspace = await OrganizationCloud.createWorkspace(f.credentials.alice, {
        projectID: "project",
        resourceID: files.resourceID,
        requestID: "files",
        name: "Files",
      })
      const environment = await OrganizationCloud.createEnvironment(f.credentials.alice, {
        projectID: "project",
        resourceID: compute.resourceID,
        requestID: "execution",
        name: "Execution",
      })
      await OrganizationSessionResources.set(f.credentials.alice, f.sessionID, {
        expectedRevision: 0,
        selection: {
          modelResourceID: model.resourceID,
          connectionResourceIDs: [],
          infrastructure: {
            workspace: { resourceID: files.resourceID, workspaceID: workspace.workspaceID },
            environment: { resourceID: compute.resourceID, environmentID: environment.environmentID },
          },
        },
      })
      return { workspace, compute, environment }
    })
    const receipt = await f.run(async () => {
      const request = f.request()
      request.input.mode = "task"
      const admitted = await f.commands.input(f.credentials.alice, request)
      if (admitted.kind !== "admitted") throw new Error("Task requires actual command admission")
      const permit = admitted.delivery.authorization.permit
      const now = Date.now()
      return Command.InputResult.parse({
        attempt: { schemaVersion: 1, permit, receivedAt: now, status: "accepted", acceptedAttemptID: permit.attemptID },
        accepted: {
          schemaVersion: 1,
          permit,
          acceptedAt: now,
          intakeSeq: 1,
          effect: { kind: "inbox", mode: "task", itemID: "inb_environment", messageID: "msg_environment" },
        },
      })
    })
    const proof = Execution.BindingProof.parse({
      schemaVersion: 1,
      purpose: "execution-root-binding",
      orgID: "org",
      deploymentIncarnation: "deployment",
      runtimeID: "runtime-alice",
      connectionEpoch: 1,
      rootID: "msg_environment",
      receipt,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 30_000,
    })
    const binding = { proof, signature: await Execution.signBinding(proof, f.machineKeys.privateKey) }
    const grant = await f.run(() => f.execution.bind(binding))
    const workspace = Cloud.FileReference.parse({
      orgID: selection.workspace.orgID,
      projectID: selection.workspace.projectID,
      resourceID: selection.workspace.resourceID,
      workspaceID: selection.workspace.workspaceID,
      generation: selection.workspace.generation,
      revision: selection.workspace.revision,
    })
    async function request(operation: Environment.Operation) {
      const proof = Environment.Proof.parse({
        version: 2,
        purpose: "organization-environment-operation",
        authority: binding,
        operation,
      })
      return { proof, signature: await Environment.sign(proof, f.machineKeys.privateKey) }
    }
    return {
      ...f,
      ...selection,
      binding,
      grant,
      request,
      workspace,
      nativeOperationID: "service-preparation-original",
      nativeOrigin: { kind: "native-test" },
      resolve: () =>
        request({
          action: "resolve",
          nativeOperationID: "service-preparation-original",
          capability: "exec",
          origin: { kind: "native-test" },
          workspace,
        }),
      async inspectPreparation(reference: Environment.Reference) {
        const proof = Execution.InspectionProof.parse({
          ...binding.proof,
          purpose: "execution-retention-inspection",
          grantID: grant.grantID,
          generation: grant.retention.generation,
        })
        const authority = { proof, signature: await Execution.signInspection(proof, f.machineKeys.privateKey) }
        const inspection = Environment.InspectionProof.parse({
          version: 2,
          kind: "preparation",
          purpose: "organization-environment-inspection",
          authority,
          reference,
          id: reference.nativeOperationID,
          origin: { kind: "native-test" },
        })
        return { proof: inspection, signature: await Environment.signInspection(inspection, f.machineKeys.privateKey) }
      },
    }
  } catch (error) {
    await f[Symbol.asyncDispose]()
    throw error
  }
}
