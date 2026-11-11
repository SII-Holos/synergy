import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { WorkspaceBinding } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { WorkspaceOperations } from "@ericsanchezok/synergy-harness/workspace/operations"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { registerNativeEnvironment } from "../../src/environment/native"
import { WorkspaceCoordinator } from "../../src/workspace/coordinator"

for (const unknown of [false, true])
  test(`Workspace maintenance reconciles the original physical file receipt without replay after a lost acknowledgement (unknown=${unknown})`, async () => {
    await using temporary = await tmpdir()
    const coordinator = new WorkspaceCoordinator({ directory: path.join(temporary.path, "claims") })
    await using runtime = await testRuntime({ register() {
      RuntimeMaintenance.configure({ required: ["workspace-operations"] })
      WorkspaceAccess.register(coordinator)
      registerNativeEnvironment({ coordinator })
    } })
    await runtime.run(async () => {
      const scope = await temporary.scope()
      const workspace = await WorkspaceBinding.register(scope.id, temporary.path)
      const environment = await Environment.bind({ scopeID: scope.id, ownerID: "fixture", provider: "native", spec: {} })
      await using resources = await EnvironmentResources.resolve({ scopeID: scope.id, workspaceID: workspace.id, environmentID: environment.id, needs: { execution: "exec" } })
      const files = resources.executor!.files!
      const write = files.write.bind(files)
      const checkpointStatus = files.checkpointStatus.bind(files)
      const lost = new Error("The original physical file write acknowledgement was lost")
      let writes = 0
      using writeFault = spyOn(files, "write").mockImplementation(async (input) => { writes++; await write(input); throw lost })
      const input = { id: "original-file-write", scopeID: scope.id, workspaceID: workspace.id, generation: workspace.binding.generation, path: "retained.bin", data: new Uint8Array([0, 255, 7]), expectedVersion: null }
      await expect(WorkspaceOperations.write(input)).rejects.toBe(lost)
      expect(new Uint8Array(await Bun.file(path.join(temporary.path, input.path)).arrayBuffer())).toEqual(input.data)
      expect((await WorkspaceOperations.get(input.id, scope.id)).state).toBe("submitted")
      using receiptFault = spyOn(files, "checkpointStatus").mockImplementation((id) => unknown ? Promise.resolve(undefined) : checkpointStatus(id))
      const lease = await RuntimeMaintenance.begin({ purpose: "organization-backup", requestID: "original-file-maintenance", actor: { kind: "system", subjectID: "operator", displayName: "Host operator", clientKind: "system", requestID: "original-file-maintenance" } })
      try {
        if (unknown) {
          await expect(RuntimeMaintenance.drain(lease)).rejects.toBeInstanceOf(RuntimeMaintenance.Blocked)
          expect((await WorkspaceOperations.get(input.id, scope.id)).state).toBe("unknown")
          expect(writes).toBe(1)
          expect((await RuntimeMaintenance.status())?.phase).toBe("draining")
        }
        receiptFault.mockRestore()
        await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
        expect((await WorkspaceOperations.get(input.id, scope.id)).state).toBe("completed")
        expect(writes).toBe(1)
        expect(await WorkspaceOperations.write(input)).toMatchObject({ id: input.id, state: "completed" })
        expect(new Uint8Array(await Bun.file(path.join(temporary.path, input.path)).arrayBuffer())).toEqual(input.data)
      } finally { await RuntimeMaintenance.release(lease) }
    })
  }, 20_000)
