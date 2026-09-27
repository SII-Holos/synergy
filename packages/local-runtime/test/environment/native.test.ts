import { expect, test } from "bun:test"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { EnvironmentExecution } from "@ericsanchezok/synergy-harness/environment/execution"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { registerNativeEnvironment } from "../../src/environment/native"
import { WorkspaceCoordinator } from "../../src/workspace/coordinator"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"

test("native provider uses the durable execution path and saves output outside its allocation", async () => {
  await using temporary = await tmpdir()
  const coordinator = new WorkspaceCoordinator({ directory: path.join(temporary.path, "claims") })
  await using runtime = await testRuntime({
    register() {
      WorkspaceAccess.register(coordinator)
      registerNativeEnvironment({ coordinator })
    },
  })
  await runtime.run(async () => {
    const environment = await Environment.bind({ scopeID: "scope", ownerID: "session", provider: "native", spec: {} })
    expect(environment.state).toBe("idle")
    const command = {
      command: process.execPath,
      args: ["-e", "process.stdout.write('native')"],
      cwd: runtime.host.root,
      env: {},
      writableRoots: [],
    }
    let execution = await EnvironmentExecution.start({
      id: "command",
      scopeID: "scope",
      environmentID: environment.id,
      command,
    })
    for (let attempt = 0; execution.state !== "exited" && attempt < 400; attempt++) {
      await Bun.sleep(10)
      execution = await EnvironmentExecution.reconcile(execution.id, "scope")
    }
    expect(execution.state).toBe("exited")
    await EnvironmentExecution.complete(execution.id, "scope", async () => ({ backend: "directory" }))
    await Environment.deallocate(environment.id, { scopeID: "scope" })
    const output = await EnvironmentExecution.output(execution.id, "scope")
    expect(output.map((chunk) => Buffer.from(chunk.data, "base64").toString()).join("")).toBe("native")
    expect(await Environment.uses(environment.id)).toHaveLength(0)
  })
}, 30_000)
