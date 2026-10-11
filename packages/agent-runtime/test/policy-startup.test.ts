import { expect, test } from "bun:test"
import { openAgentRuntime, type RuntimeComponent } from "../src"
import { ConfigSource } from "@ericsanchezok/synergy-harness/config/source"
import { ModelExecution } from "@ericsanchezok/synergy-harness/execution/model-execution"
import { PolicyWorker } from "@ericsanchezok/synergy-harness/enforcement/policy-worker"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import { version } from "../package.json" with { type: "json" }

for (const prewarm of [false, undefined]) {
  test(`policy isolation starts on demand when selected, with eager startup retained by default (${prewarm})`, async () => {
    await using fixture = await runtimeHome()
    const component: RuntimeComponent = {
      id: "policy-startup-test",
      version,
      apiVersion: 1,
      register() {
        ModelExecution.register("in-process")
        ConfigSource.register({
          async resolve() {
            return {
              execution: { policyWorkers: 1, ...(prewarm === undefined ? {} : { policyWorkerPrewarm: prewarm }) },
            }
          },
        })
      },
    }
    await using runtime = await openAgentRuntime({
      home: fixture.host.root,
      host: fixture.host,
      components: [component],
      mode: "server",
      listen: false,
    })
    await runtime.run(async () => {
      expect(PolicyWorker.stats().workers).toBe(prewarm === false ? 0 : 1)
      const input = {
        context: {
          activeWorkspace: fixture.host.root,
          workspaceType: "worktree",
          registeredMcpTools: [],
          registeredPluginTools: [],
          pluginToolCapabilities: {},
        },
        toolName: "bash",
        args: { command: "ls |& cat" },
      }
      expect(await PolicyWorker.classify(input)).toMatchObject({
        capabilities: [{ class: "shell", nonBypassable: false }],
      })
      expect(PolicyWorker.stats().workers).toBe(1)
      await PolicyWorker.stop()
      expect(PolicyWorker.stats().workers).toBe(0)
      await expect(PolicyWorker.classify(input)).rejects.toThrow("stopping")
      PolicyWorker.prewarm()
      expect(PolicyWorker.stats().workers).toBe(0)
    })
  }, 30_000)
}
