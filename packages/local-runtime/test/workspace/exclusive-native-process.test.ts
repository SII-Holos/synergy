import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { OwnedProcess } from "../../src/process/owned-process"
import { WorkspaceCoordinator } from "../../src/workspace/coordinator"
import { testRuntime } from "../support/runtime"

test.skipIf(!["darwin", "linux", "win32"].includes(process.platform))(
  "exclusive access refuses an active original native process and preserves its physical owner",
  async () => {
    await using directory = await tmpdir()
    const coordinator = new WorkspaceCoordinator({ directory: path.join(directory.path, "claims") })
    await using runtime = await testRuntime({ workspaceCoordinator: coordinator })
    await runtime.run(async () => {
      const lease = await coordinator.acquire({
        id: crypto.randomUUID(),
        owner: "native-exclusive-fixture",
        ancestors: [],
        kind: "process",
        roots: [],
        useRoots: [directory.path],
        retainAfterExit: true,
        durable: true,
      })
      let owned: Awaited<ReturnType<typeof OwnedProcess.prepare>> | undefined
      let entered = false
      try {
        owned = await OwnedProcess.prepare({
          command: process.execPath,
          args: ["-e", "setInterval(() => {}, 1000)"],
          cwd: directory.path,
          env: {},
          ownership: lease,
        })
        await owned.activate()
        expect(owned.child.alive?.()).toBe(true)
        const claims = await coordinator.inspect()
        expect(claims.find((claim) => claim.id === lease.id)).toMatchObject({
          kind: "process",
          state: "active",
          processBound: true,
          processTree: expect.objectContaining({
            kind:
              process.platform === "win32"
                ? "windows-job"
                : process.platform === "darwin"
                  ? "darwin-coalition"
                  : "linux-subreaper",
          }),
        })
        await expect(
          WorkspaceAccess.exclusive([directory.path], async () => {
            entered = true
          }),
        ).rejects.toBeInstanceOf(WorkspaceAccess.BusyError)
        expect(entered).toBe(false)
        expect(owned.child.alive?.()).toBe(true)
      } finally {
        try {
          await owned?.stop()
        } finally {
          await lease.release()
        }
      }
      expect(await coordinator.inspect()).toHaveLength(0)
    })
  },
  20000,
)
