import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import {
  OrganizationCloudProtocol as Cloud,
  OrganizationExecutionProtocol as Execution,
} from "@ericsanchezok/synergy-organization-protocol"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { WorkspaceOperations } from "@ericsanchezok/synergy-harness/workspace/operations"
import type { WorkspaceFileHost } from "@ericsanchezok/synergy-harness/workspace/protocol"
import { withTimeout } from "@ericsanchezok/synergy-harness/util/timeout"
import { WorkspaceCoordinator } from "@ericsanchezok/synergy-local-runtime/workspace/coordinator"
import { OrganizationCloud } from "../src/cloud"
import { createOrganizationCloudEnvironments, registerOrganizationCloudEnvironments } from "../src/cloud-environments"
import { OrganizationServiceMaintenance } from "../src/service-maintenance"
import { OrganizationProjects } from "../src/projects"
import { organizationApp } from "../src/http"
import { selectedEnvironmentTask } from "./support/environment-task"
import { controlledEnvironment } from "./support/native-environment-provider"

async function fixture() {
  const directory = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "live-file-permission-"))
  const coordinator = new WorkspaceCoordinator({ directory: path.join(directory, "coordination") })
  const native = controlledEnvironment(path.join(directory, "host"), coordinator)
  let inspect: (() => Promise<void>) | undefined,
    writes = 0,
    dropAcknowledgement = false
  const wrapped = new WeakSet<WorkspaceFileHost>()
  const connect = native.provider.connect!.bind(native.provider)
  native.provider.connect = async (...args) => {
    const executor = await connect(...args)
    const files = executor.files
    if (files && !wrapped.has(files)) {
      wrapped.add(files)
      const originalInspect = files.inspect.bind(files),
        originalWrite = files.write.bind(files)
      files.inspect = async (mount) => {
        const value = await originalInspect(mount)
        await inspect?.()
        return value
      }
      files.write = async (input) => {
        writes++
        return originalWrite(input)
      }
    }
    return executor
  }
  const blobs = new Map<string, Uint8Array>()
  const f = await selectedEnvironmentTask({
    cloud: {
      blobStores: {
        authority: {
          async put(hash, bytes) {
            blobs.set(hash, bytes.slice())
          },
          async get(hash) {
            const bytes = blobs.get(hash)
            if (!bytes) throw new Error("Missing actual Workspace object")
            return bytes.slice()
          },
        },
      },
      workspaceProfiles: { authority: { blobStore: "authority" } },
      environmentProviders: [native.provider],
      environmentProfiles: { authority: { provider: native.provider.id, spec: {} } },
    },
    register() {
      OrganizationServiceMaintenance.register()
      registerOrganizationCloudEnvironments()
    },
  })
  const environments = await f.run(() => createOrganizationCloudEnvironments({ grants: f.execution }))
  const run = <T>(body: () => Promise<T>) => f.run(() => OrganizationServiceMaintenance.run(body))
  const app = organizationApp(
    () => true,
    undefined,
    "https://organization.example",
    undefined,
    f.connections,
    undefined,
    f.forwarder,
    f.execution,
    f.gateway,
    undefined,
    undefined,
    undefined,
    environments,
  )
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const response = await run(async () => app.fetch(request))
      if (
        dropAcknowledgement &&
        response.status === 200 &&
        new URL(request.url).pathname === "/runtime/v1/workspaces/files"
      ) {
        dropAcknowledgement = false
        return Response.json(
          {
            code: "COMMAND_OUTCOME_UNKNOWN",
            message: "The original HTTP acknowledgement was lost",
            outcome: "unknown",
            retryable: false,
          },
          { status: 504 },
        )
      }
      return response
    },
  })
  const post = (pathname: string, body: unknown) =>
    fetch(new URL(pathname, server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  async function file(operation: Cloud.FileOperation, reference?: Cloud.FileReference) {
    const proof = Cloud.FileProof.parse({
      purpose: "organization-workspace-file",
      authority: f.binding,
      operation,
      reference,
    })
    return post("/runtime/v1/workspaces/files", {
      proof,
      signature: await Cloud.signFile(proof, f.machineKeys.privateKey),
    })
  }
  async function inspection(
    operation: { action: "receipt" | "acknowledge"; id: string },
    reference: Cloud.FileReference,
  ) {
    const proof = Execution.InspectionProof.parse({
      ...f.binding.proof,
      purpose: "execution-retention-inspection",
      grantID: f.grant.grantID,
      generation: f.grant.retention.generation,
    })
    const authority = { proof, signature: await Execution.signInspection(proof, f.machineKeys.privateKey) }
    const selected = Cloud.FileInspectionProof.parse({
      purpose: "organization-workspace-file-inspection",
      authority,
      reference,
      operation,
    })
    return { proof: selected, signature: await Cloud.signFileInspection(selected, f.machineKeys.privateKey) }
  }
  await run(() => environments.ready())
  const resolve = await f.resolve()
  await run(() => environments.request(resolve))
  const described = await file({ action: "describe" })
  if (described.status !== 200) throw new Error("The actual mounted Workspace did not become readable")
  const reference = Cloud.FileResult.parse(await described.json()).reference
  return {
    ...f,
    directory,
    reference,
    file,
    inspection,
    post,
    native,
    writes: () => writes,
    setInspect: (body: (() => Promise<void>) | undefined) => {
      inspect = body
    },
    loseAcknowledgement() {
      dropAcknowledgement = true
    },
    async revoke() {
      await f.run(async () => {
        const project = await OrganizationProjects.get(f.credentials.admin, "project")
        await OrganizationProjects.member(f.credentials.admin, "project", "alice", {
          expectedRevision: project.revision,
          role: null,
        })
      })
    },
    uses: () =>
      f.run(() => Environment.uses(f.environment.environmentID).then((uses) => uses.map((use) => use.id).sort())),
    [Symbol.asyncDispose]: async () => {
      inspect = undefined
      await server.stop(true)
      await f.run(() => environments.close())
      await f.run(OrganizationServiceMaintenance.stop)
      await f[Symbol.asyncDispose]()
      await native.provider.close?.()
      await fs.rm(directory, { recursive: true, force: true })
    },
  }
}

test("revocation while the final real mount inspection is held prevents native write and returns its short Uses", async () => {
  await using f = await fixture()
  const baseline = await f.uses(),
    entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>()
  const scopeID = OrganizationCloud.scopeID(f.grant.orgID, f.grant.projectID)
  f.setInspect(async () => {
    if (Storage.inTransaction()) return
    const active = await WorkspaceOperations.listActive(scopeID)
    if (
      !active.some((operation) => operation.workspaceID === f.reference.workspaceID && operation.state === "submitted")
    )
      return
    f.setInspect(undefined)
    entered.resolve()
    await release.promise
  })
  const writing = f.file(
    {
      action: "write",
      id: "revoked-before-effect",
      path: "forbidden.txt",
      data: Buffer.from("not authorized").toString("base64"),
      expectedVersion: null,
    },
    f.reference,
  )
  try {
    await withTimeout(entered.promise, 5_000)
    await f.revoke()
    release.resolve()
    expect((await writing).status).toBeGreaterThanOrEqual(400)
    expect(f.writes()).toBe(0)
    expect(await f.uses()).toEqual(baseline)
    expect(f.native.allocations()).toBe(1)
  } finally {
    release.resolve()
    await writing
  }
}, 15_000)

test("a lost HTTP ACK followed by role removal permits only original metadata receipt and ACK without a second effect", async () => {
  await using f = await fixture()
  const baseline = await f.uses()
  const operation = {
    action: "write" as const,
    id: "accepted-before-revocation",
    path: "retained.txt",
    data: Buffer.from("actual accepted bytes").toString("base64"),
    expectedVersion: null,
  }
  f.loseAcknowledgement()
  expect((await f.file(operation, f.reference)).status).toBe(504)
  expect(f.writes()).toBe(1)
  await f.revoke()
  expect((await f.file({ ...operation, id: "new-denied-effect" }, f.reference)).status).toBe(404)
  expect(
    (await f.file({ action: "read", path: operation.path, offset: 0, maximumBytes: 100 }, f.reference)).status,
  ).toBe(404)
  const original = await f.inspection({ action: "receipt", id: operation.id }, f.reference)
  const response = await f.post("/runtime/v1/workspaces/files/inspection", original)
  expect(response.status).toBe(200)
  const receipt = Cloud.FileResult.parse(await response.json())
  if (receipt.result.action !== "receipt") throw new Error("Original receipt did not retain its metadata contract")
  expect(receipt.result.status?.state).toBe("saved")
  expect(JSON.stringify(receipt)).not.toContain(f.directory)
  const ack = await f.post(
    "/runtime/v1/workspaces/files/inspection",
    await f.inspection({ action: "acknowledge", id: operation.id }, f.reference),
  )
  expect(ack.status).toBe(200)
  expect(Cloud.FileResult.parse(await ack.json()).result).toEqual({ action: "acknowledge", id: operation.id })
  const body = await f.post("/runtime/v1/workspaces/files/inspection", {
    ...original,
    proof: { ...original.proof, operation: { action: "read", path: operation.path, offset: 0, maximumBytes: 100 } },
  })
  expect(body.status).toBe(400)
  expect(f.writes()).toBe(1)
  expect(await f.uses()).toEqual(baseline)
  expect(f.native.allocations()).toBe(1)
}, 15_000)
