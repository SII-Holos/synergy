import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { OrganizationCloudProtocol as Wire } from "@ericsanchezok/synergy-organization-protocol"
import { WorkspaceCoordinator } from "@ericsanchezok/synergy-local-runtime/workspace/coordinator"
import type { WorkspaceFileHost } from "@ericsanchezok/synergy-harness/workspace/protocol"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { OrganizationCloud } from "../src/cloud"
import { createOrganizationCloudEnvironments, registerOrganizationCloudEnvironments } from "../src/cloud-environments"
import { OrganizationServiceMaintenance } from "../src/service-maintenance"
import { selectedEnvironmentTask } from "./support/environment-task"
import { controlledEnvironment } from "./support/native-environment-provider"

test("active Workspace list and CAS mutations retain original native checkpoints and lost acknowledgements", async () => {
  const directory = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "active-cloud-files-"))
  const coordinator = new WorkspaceCoordinator({ directory: path.join(directory, "coordination") })
  const native = controlledEnvironment(path.join(directory, "host"), coordinator)
  let loseAcknowledgement = false,
    calls = 0
  const wrapped = new WeakSet<WorkspaceFileHost>()
  const connect = native.provider.connect!.bind(native.provider)
  native.provider.connect = async (...args) => {
    const executor = await connect(...args)
    const files = executor.files
    if (files && !wrapped.has(files)) {
      wrapped.add(files)
      const write = files.write.bind(files)
      files.write = async (input) => {
        const checkpoint = await write(input)
        if (loseAcknowledgement && ++calls === 1) throw new Error("Original native write acknowledgement was lost")
        return checkpoint
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
            if (!bytes) throw new Error("Missing native object")
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
  const request = async (operation: Wire.FileOperation, reference?: Wire.FileReference) => {
    const proof = Wire.FileProof.parse({
      purpose: "organization-workspace-file",
      authority: f.binding,
      operation,
      reference,
    })
    const signed = { proof, signature: await Wire.signFile(proof, f.machineKeys.privateKey) }
    return run(() =>
      f.execution.withWorkspace(signed, undefined, (evidence) =>
        OrganizationCloud.file(evidence, undefined, environments.withWorkspaceFiles),
      ),
    )
  }
  try {
    await run(() => environments.ready())
    const resolving = await f.resolve()
    await run(() => environments.request(resolving))
    const described = await request({ action: "describe" })
    const before = described.reference
    const written = await request(
      {
        action: "write",
        id: "original-write",
        path: "a.txt",
        data: Buffer.from("first").toString("base64"),
        expectedVersion: null,
      },
      before,
    )
    expect(written.result.action).toBe("write")
    expect(written.reference.revision).toBeGreaterThan(before.revision)
    expect(
      await request(
        {
          action: "write",
          id: "original-write",
          path: "a.txt",
          data: Buffer.from("first").toString("base64"),
          expectedVersion: null,
        },
        before,
      ),
    ).toEqual(written)
    await expect(
      request(
        {
          action: "write",
          id: "original-write",
          path: "a.txt",
          data: Buffer.from("changed").toString("base64"),
          expectedVersion: null,
        },
        before,
      ),
    ).rejects.toThrow()
    const listed = await request({ action: "list", path: "", limit: 1 }, written.reference)
    if (listed.result.action !== "list") throw new Error("Expected live directory page")
    expect(listed.result.items.map((item) => item.path)).toEqual(["a.txt"])
    const read = await request({ action: "read", path: "a.txt", offset: 0, maximumBytes: 20 }, written.reference)
    if (read.result.action !== "read") throw new Error("Expected actual live bytes")
    expect(Buffer.from(read.result.data, "base64").toString()).toBe("first")
    await expect(
      request(
        {
          action: "write",
          id: "stale-write",
          path: "a.txt",
          data: Buffer.from("stale").toString("base64"),
          expectedVersion: read.result.version,
        },
        before,
      ),
    ).rejects.toThrow()
    const changed = await request(
      { action: "mutate", id: "original-mkdir", change: { kind: "mkdir", path: "sub" } },
      written.reference,
    )
    expect(changed.result.action).toBe("mutate")
    loseAcknowledgement = true
    const operation = {
      action: "write" as const,
      id: "lost-ack",
      path: "b.txt",
      data: Buffer.from("retained").toString("base64"),
      expectedVersion: null,
    }
    await request(operation, changed.reference).catch(() => undefined)
    const receipt = await request({ action: "receipt", id: operation.id }, changed.reference)
    if (receipt.result.action !== "receipt") throw new Error("Expected original publication receipt")
    expect(receipt.result.status?.state).toBe("saved")
    await request(operation, changed.reference)
    expect(calls).toBe(1)
    expect(
      (await f.run(() => Environment.uses(f.environment.environmentID))).filter(
        (use) => use.ownership.kind === "workspace-operation",
      ),
    ).toEqual([])
    expect(native.allocations()).toBe(1)
  } finally {
    await f.run(() => environments.close())
    await f.run(OrganizationServiceMaintenance.stop)
    await f[Symbol.asyncDispose]()
    await native.provider.close?.()
    await fs.rm(directory, { recursive: true, force: true })
  }
})
