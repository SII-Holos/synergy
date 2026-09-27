import { expect, test } from "bun:test"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { EnvironmentExecution } from "@ericsanchezok/synergy-harness/environment/execution"
import { EnvironmentProviders } from "@ericsanchezok/synergy-harness/environment/provider"
import { dockerEnvironment } from "../../src/environment/docker"

const image = process.env.SYNERGY_TEST_DOCKER_ENVIRONMENT_IMAGE

test.skipIf(!image)(
  "Docker compute starts on demand, preserves output and runs commands without host credentials",
  async () => {
    const provider = dockerEnvironment({
      endpoint: process.env.SYNERGY_TEST_DOCKER_HOST ?? "unix:///var/run/docker.sock",
    })
    await using runtime = await testRuntime({ register: () => EnvironmentProviders.register(provider) })
    await runtime.run(async () => {
      const environment = await Environment.bind({
        scopeID: "scope",
        ownerID: "session",
        provider: "docker",
        spec: { image: image! },
      })
      expect(environment.state).toBe("idle")
      try {
        let operation = await EnvironmentExecution.start({
          id: "operation",
          environmentID: environment.id,
          scopeID: "scope",
          command: {
            command: "/bin/sh",
            args: ["-c", 'id -u; printf docker; test -z "$SYNERGY_EXECUTION_TOKEN"'],
            cwd: "/tmp",
            env: {},
            writableRoots: null,
          },
        })
        for (let attempt = 0; operation.state !== "exited" && attempt < 300; attempt++) {
          await Bun.sleep(20)
          operation = await EnvironmentExecution.reconcile(operation.id, "scope")
        }
        expect(operation.status?.exitCode).toBe(0)
        await EnvironmentExecution.complete(operation.id, "scope", async () => ({ backend: "none" }))
        await Environment.deallocate(environment.id, { scopeID: "scope" })
        const output = await EnvironmentExecution.output(operation.id, "scope")
        expect(
          output
            .filter((chunk) => chunk.stream === "stdout")
            .map((chunk) => Buffer.from(chunk.data, "base64").toString())
            .join(""),
        ).toBe("1000\ndocker")
        expect((await Environment.get(environment.id, "scope")).state).toBe("idle")
      } catch (error) {
        const list = Bun.spawn(["docker", "ps", "-aq", "--filter", `label=io.synergy.environment=${environment.id}`], {
          stdout: "pipe",
          stderr: "ignore",
        })
        const id = (await new Response(list.stdout).text()).trim()
        if (id) {
          const logs = Bun.spawn(["docker", "logs", id], { stdout: "pipe", stderr: "pipe" })
          const [output, stderr] = await Promise.all([
            new Response(logs.stdout).text(),
            new Response(logs.stderr).text(),
          ])
          throw new Error(
            `${error instanceof Error ? error.message : "Docker test failed"}\n${(output + stderr).slice(-8192)}`,
          )
        }
        throw error
      } finally {
        const current = await Environment.get(environment.id, "scope")
        if (current.allocation) await provider.deallocate(Environment.requestOf(current))
      }
    })
  },
  120_000,
)
