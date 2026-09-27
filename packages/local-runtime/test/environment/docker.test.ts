import { expect, test } from "bun:test"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { EnvironmentExecution } from "@ericsanchezok/synergy-harness/environment/execution"
import { EnvironmentProviders } from "@ericsanchezok/synergy-harness/environment/provider"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { dockerEnvironment } from "../../src/environment/docker"
import { WorkspaceBlobs, WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceMounts } from "@ericsanchezok/synergy-harness/workspace/mount"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"

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
            args: [
              "-c",
              'id -u; printf docker; test -z "$SYNERGY_EXECUTION_TOKEN"; test "$(sed -n "s/^CapEff:[[:space:]]*//p" /proc/self/status)" = 0000000000000000',
            ],
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

test.skipIf(!image)(
  "Docker Workspace checkpoints survive upload failure and replacement of the entire allocation",
  async () => {
    let failUploads = false
    const provider = dockerEnvironment({
      endpoint: process.env.SYNERGY_TEST_DOCKER_HOST ?? "unix:///var/run/docker.sock",
    })
    await using runtime = await testRuntime({
      register() {
        EnvironmentProviders.register(provider)
        WorkspaceBlobs.register("fixture", {
          async put(hash, bytes) {
            if (failUploads) throw new Error("object store unavailable")
            await Storage.writeBinary(["test_workspace_blob", hash], bytes)
          },
          get: (hash) => Storage.readBinary(["test_workspace_blob", hash]),
        })
      },
    })
    await runtime.run(async () => {
      const environment = await Environment.bind({
        scopeID: "scope",
        ownerID: "session",
        provider: "docker",
        spec: { image: image! },
      })
      const workspace = await WorkspaceCatalog.create({
        scopeID: "scope",
        backend: { provider: "objects", spec: { blobStore: "fixture" } },
      })
      const selection = { workspaceID: workspace.id, scopeID: "scope" }
      await WorkspaceContent.write(selection, {
        path: "source",
        data: new TextEncoder().encode("initial"),
        expectedVersion: null,
      })
      try {
        const resolved = await EnvironmentResources.resolve({
          ...selection,
          environmentID: environment.id,
          needs: { execution: "exec" },
        })
        const mounted = resolved.workspace!
        expect(resolved.runtime?.platform).toBe("linux")
        expect(resolved.runtime?.shell).toBe("/bin/bash")
        expect(resolved.runtime?.env).not.toHaveProperty("SYNERGY_EXECUTION_TOKEN")
        await resolved.release()
        const target = mounted.activeMount!.path
        let operation = await EnvironmentExecution.start({
          id: "transform",
          scopeID: "scope",
          environmentID: environment.id,
          workspaces: [WorkspaceMounts.reference(mounted)],
          command: {
            command: "/bin/sh",
            args: ["-c", "cat source > result; printf changed >> result; printf once >> effects"],
            cwd: target,
            env: {},
            writableRoots: [target],
          },
        })
        for (let attempt = 0; operation.state !== "exited" && attempt < 500; attempt++) {
          await Bun.sleep(20)
          operation = await EnvironmentExecution.reconcile(operation.id, "scope")
        }
        expect(operation.status?.exitCode).toBe(0)
        failUploads = true
        await expect(EnvironmentExecution.complete(operation.id, "scope")).rejects.toThrow("object store unavailable")
        expect((await EnvironmentExecution.get(operation.id, "scope")).state).toBe("unsaved")
        await expect(Environment.deallocate(environment.id, { scopeID: "scope" })).rejects.toMatchObject({
          name: "EnvironmentBusy",
        })
        await expect(WorkspaceContent.read(selection, "source")).rejects.toThrow("active mount")
        failUploads = false
        await EnvironmentExecution.complete(operation.id, "scope")
        await Environment.deallocate(environment.id, { scopeID: "scope" })
        expect(await WorkspaceContent.read(selection, "result")).toEqual(new TextEncoder().encode("initialchanged"))
        const restored = await WorkspaceMounts.attach({ ...selection, environmentID: environment.id })
        expect(restored.activeMount!.target.generation).toBe(mounted.activeMount!.target.generation + 1)
        const files = await WorkspaceMounts.connect(restored)
        expect(
          Buffer.from(
            (await files.read({ mount: WorkspaceMounts.reference(restored), path: "effects", maximumBytes: 100 })).data,
            "base64",
          ).toString(),
        ).toBe("once")
        await Environment.deallocate(environment.id, { scopeID: "scope" })
      } finally {
        const current = await Environment.get(environment.id, "scope")
        if (current.allocation) await provider.deallocate(Environment.requestOf(current))
      }
    })
  },
  120_000,
)
