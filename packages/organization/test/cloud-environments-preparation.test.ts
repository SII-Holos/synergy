import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { ExecutionProtocol } from "@ericsanchezok/synergy-harness/environment/executor"
import {
  OrganizationCloudExecutionProtocol as Protocol,
  OrganizationExecutionProtocol as Execution,
} from "@ericsanchezok/synergy-organization-protocol"
import { NativeExecutor } from "@ericsanchezok/synergy-local-runtime/environment/native-executor"
import { WorkspaceCoordinator } from "@ericsanchezok/synergy-local-runtime/workspace/coordinator"
import { testResources } from "@ericsanchezok/synergy-testing/resources"
import { createOrganizationCloudEnvironments, registerOrganizationCloudEnvironments } from "../src/cloud-environments"
import { OrganizationServiceMaintenance } from "../src/service-maintenance"
import { OrganizationResources } from "../src/resources"
import { controlledEnvironment } from "./support/native-environment-provider"
import { selectedEnvironmentTask } from "./support/environment-task"

async function preparationFixture() {
  const resources = testResources()
  try {
    const directory = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "service-preparation-"))
    resources.defer("native preparation directory", () => fs.rm(directory, { recursive: true, force: true }))
    const coordinator = new WorkspaceCoordinator({ directory: path.join(directory, "coordination") })
    const native = controlledEnvironment(path.join(directory, "host"), coordinator)
    resources.defer("native preparation executor", () => native.provider.close?.())
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
              if (!bytes) throw new Error("Original Workspace object is missing")
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
    resources.defer("signed preparation service", async () => {
      await f.run(() => environments.close())
      await f.run(OrganizationServiceMaintenance.stop)
      await f[Symbol.asyncDispose]()
    })
    const run = <T>(body: () => Promise<T>) => f.run(() => OrganizationServiceMaintenance.run(body))
    await run(() => environments.ready())
    return {
      ...f,
      environments,
      allocations: native.allocations,
      invoke: (request: Protocol.Request) => run(() => environments.request(request)),
      inspect: (request: Protocol.InspectionRequest) => run(() => environments.inspect(request)),
      uses: () => f.run(() => Environment.uses(f.environment.environmentID)),
      close: () => f.run(() => environments.close()),
      [Symbol.asyncDispose]: () => resources.close(),
    }
  } catch (error) {
    await resources.close()
    throw error
  }
}

const bytes = Buffer.from([0, 255, 17, 128, 10])
function inputs(id: string) {
  return { id, files: [{ name: "payload.bin", data: bytes.toString("base64") }] }
}

test("an admission release with a lost native acknowledgement retains its original cleanup owner", async () => {
  await using f = await preparationFixture()
  const acquire = Environment.acquire
  let releases = 0
  const fault = spyOn(Environment, "acquire").mockImplementation(async (...args) => {
    const use = await acquire(...args)
    if (
      args[0] !== f.environment.environmentID ||
      use.use.kind !== "admission" ||
      use.use.ownership.kind !== "admission" ||
      use.use.ownership.origin.kind !== "host" ||
      use.use.ownership.origin.owner !== "organization-environment"
    )
      return use
    return {
      ...use,
      async release() {
        await use.release()
        if (++releases === 1)
          throw new Error("Original admission release committed but its native acknowledgement was lost")
      },
    }
  })
  try {
    const { reference } = await f.invoke(await f.resolve())
    const retainedUses = (await f.uses()).filter((use) => use.kind !== "admission")
    const proof = Execution.InspectionProof.parse({
      ...f.binding.proof,
      purpose: "execution-retention-inspection",
      grantID: f.grant.grantID,
      generation: f.grant.retention.generation,
    })
    const authority = { proof, signature: await Execution.signInspection(proof, f.machineKeys.privateKey) }
    const original = { kind: "admission", reference, origin: f.nativeOrigin, authority, version: 2 }
    const retirement = Protocol.RetirementProof.parse({ ...original, purpose: "organization-environment-retirement" })
    const request = {
      proof: retirement,
      signature: await Protocol.signRetirement(retirement, f.machineKeys.privateKey),
    }
    const inspection = Protocol.RetirementInspectionProof.parse({
      ...original,
      purpose: "organization-environment-retirement-inspection",
    })
    const observed = {
      proof: inspection,
      signature: await Protocol.signRetirementInspection(inspection, f.machineKeys.privateKey),
    }
    const retire = () => f.run(() => OrganizationServiceMaintenance.run(() => f.environments.retire(request)))
    const inspect = () =>
      f.run(() => OrganizationServiceMaintenance.run(() => f.environments.inspectRetirement(observed)))
    await expect(retire()).rejects.toMatchObject({ data: { outcome: "unknown" } })
    expect((await f.uses()).filter((use) => use.kind === "admission")).toHaveLength(0)
    expect(releases).toBe(1)
    expect(await inspect()).toMatchObject({ kind: "admission", released: false })
    expect(releases).toBe(1)
    expect(await retire()).toMatchObject({ kind: "admission", released: true })
    expect(releases).toBe(2)
    expect(await inspect()).toMatchObject({ kind: "admission", released: true })
    expect(await f.uses()).toEqual(retainedUses)
    await f.run(async () => f.environments.assertDrained(f.grant.grantID))
  } finally {
    fault.mockRestore()
  }
})

test("signed Service preparation retains the original native Use and cannot substitute its operation", async () => {
  await using f = await preparationFixture()
  const resolved = await f.invoke(await f.resolve())
  expect(resolved.reference.nativeOperationID).toBe(f.nativeOperationID)
  const request = await f.request({
    action: "prepare-inputs",
    reference: resolved.reference,
    id: f.nativeOperationID,
    input: inputs(f.nativeOperationID),
  })
  const changed = structuredClone(request)
  if (changed.proof.operation.action !== "prepare-inputs") throw new Error("Expected original input preparation")
  changed.proof.operation.id = "another-operation"
  await expect(f.invoke(changed)).rejects.toMatchObject({ data: { code: "PERMISSION_DENIED" } })
  const prepared = ExecutionProtocol.PreparedInputs.parse((await f.invoke(request)).value)
  const identity = await Protocol.operationIdentity(resolved.reference, f.nativeOperationID, f.nativeOrigin)
  const uses = await f.uses()
  const original = uses.find((use) => use.ownership.kind === "execution-preparation")
  expect(original?.ownership.kind).toBe("execution-preparation")
  if (!original || original.ownership.kind !== "execution-preparation")
    throw new Error("Native preparation has no canonical original Use")
  expect(original.ownership.operationID).toBe(identity.operationID)
  expect(original.target).toEqual(Environment.Target.parse(resolved.reference.target))
  const preparedPath = prepared.paths["payload.bin"]
  if (!preparedPath) throw new Error("Original native inputs have no prepared path")
  expect(await Bun.file(preparedPath).bytes()).toEqual(new Uint8Array(bytes))
  const inspection = await f.inspect(await f.inspectPreparation(resolved.reference))
  if (inspection.kind !== "preparation") throw new Error("Expected actual preparation inspection")
  const physical = ExecutionProtocol.Preparation.parse(inspection.preparation)
  expect(physical.id).toBe(identity.operationID)
  expect(physical.state).toBe("prepared")
  await f.invoke(await f.request({ action: "release-admission", reference: resolved.reference }))
  expect((await f.uses()).some((use) => use.ownership.kind === "execution-preparation")).toBe(false)
  expect(await Bun.file(preparedPath).exists()).toBe(false)
  expect(f.allocations()).toBe(1)
})

test("unknown preparation is inspected without recompilation and original cleanup survives revocation and lost acknowledgement", async () => {
  await using f = await preparationFixture()
  const resolved = await f.invoke(await f.resolve())
  const prepare = NativeExecutor.prototype.prepareInputs
  let prepared = 0
  const lost = new Error("Original durable preparation acknowledgement was lost")
  using unknown = spyOn(NativeExecutor.prototype, "prepareInputs").mockImplementation(async function (
    this: NativeExecutor,
    input,
  ) {
    prepared++
    await prepare.call(this, input)
    throw lost
  })
  const request = await f.request({
    action: "prepare-inputs",
    reference: resolved.reference,
    id: f.nativeOperationID,
    input: inputs(f.nativeOperationID),
  })
  await expect(f.invoke(request)).rejects.toMatchObject({ data: { outcome: "unknown" } })
  expect(prepared).toBe(1)
  expect((await f.uses()).filter((use) => use.ownership.kind === "execution-preparation")).toHaveLength(1)
  const observed = await f.inspect(await f.inspectPreparation(resolved.reference))
  if (observed.kind !== "preparation") throw new Error("Expected actual retained preparation inspection")
  const original = ExecutionProtocol.Preparation.parse(observed.preparation)
  expect(original.state).toBe("prepared")
  await expect(f.invoke(request)).rejects.toMatchObject({ data: { outcome: "unknown" } })
  expect(prepared).toBe(1)
  await f.run(() =>
    OrganizationResources.update(f.credentials.admin, f.compute.resourceID, {
      expectedRevision: f.compute.revision,
      state: "disabled",
    }),
  )
  await expect(f.invoke(request)).rejects.toMatchObject({ data: { code: "RESOURCE_UNAVAILABLE" } })
  const disabled = await f.inspect(await f.inspectPreparation(resolved.reference))
  expect(disabled.kind).toBe("preparation")
  unknown.mockRestore()
  const release = NativeExecutor.prototype.releasePreparation
  const inspect = NativeExecutor.prototype.inspectPreparation
  let released = false
  let reachable = false
  const lostRelease = new Error("Original physical preparation was closed before acknowledgement was lost")
  using unavailable = spyOn(NativeExecutor.prototype, "inspectPreparation").mockImplementation(async function (
    this: NativeExecutor,
    id,
  ) {
    if (released && !reachable) throw new Error("Original preparation receipt is temporarily unreachable")
    return inspect.call(this, id)
  })
  using cleanup = spyOn(NativeExecutor.prototype, "releasePreparation").mockImplementation(async function (
    this: NativeExecutor,
    id,
  ) {
    await release.call(this, id)
    if (!released) {
      released = true
      throw lostRelease
    }
  })
  await expect(f.close()).rejects.toThrow()
  expect(released).toBe(true)
  expect((await f.uses()).filter((use) => use.ownership.kind === "execution-preparation")).toHaveLength(1)
  reachable = true
  await f.close()
  expect((await f.uses()).some((use) => use.ownership.kind === "execution-preparation")).toBe(false)
  expect(f.allocations()).toBe(1)
  expect(prepared).toBe(1)
})
