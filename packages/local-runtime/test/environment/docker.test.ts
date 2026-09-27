import { WorkspaceState } from "@ericsanchezok/synergy-harness/workspace/state"
import { WorkspaceFileService } from "../../src/workspace-file/service"
import { WorktreeProcess } from "../../src/workspace/process"
import { ViewFileTool } from "../../src/tools/view-file"
import { EditTool } from "../../src/tools/edit"
import { AttachTool } from "../../src/tools/attach"
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

import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import { testRuntime as localRuntime } from "../support/runtime"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { Pty } from "../../src/process/pty"
import { shell } from "../../src/session/shell"

const image = process.env.SYNERGY_TEST_DOCKER_ENVIRONMENT_IMAGE

test.skipIf(!image)(
  "Docker compute starts on demand, preserves output and runs commands without host credentials",
  async () => {
    const provider = dockerEnvironment({
      id: "fixture-docker",
      endpoint: process.env.SYNERGY_TEST_DOCKER_HOST ?? "unix:///var/run/docker.sock",
    })
    await using runtime = await testRuntime({ register: () => EnvironmentProviders.register(provider) })
    await runtime.run(async () => {
      const environment = await Environment.bind({
        scopeID: "scope",
        ownerID: "session",
        provider: provider.id,
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
              'id -u; mkdir -p /workspaces/.scratch/outside /workspaces/.scratch/.aws /workspaces/.scratch/selected; printf secret > /workspaces/.scratch/.aws/credentials; printf ordinary > /workspaces/.scratch/outside/readable; printf docker; test -z "$SYNERGY_EXECUTION_TOKEN"; test "$(sed -n "s/^CapEff:[[:space:]]*//p" /proc/self/status)" = 0000000000000000',
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
        const executor = await EnvironmentExecution.connect(operation)
        const inputs = await executor.prepareInputs!({
          id: "sandboxed",
          files: [{ name: "note.md", data: Buffer.from("reviewed note").toString("base64") }],
        })
        const wrapper = await executor.prepareSandbox!({
          command: "/usr/bin/python3",
          args: [
            "-c",
            `
from pathlib import Path
import socket
assert Path(${JSON.stringify(inputs.paths["note.md"])}).read_text() == "reviewed note"
try:
    Path(${JSON.stringify(inputs.paths["note.md"])}).write_text("changed")
    raise AssertionError("staged input was writable")
except OSError:
    pass
Path("allowed").write_text("contained")
assert Path("/workspaces/.scratch/outside/readable").read_text() == "ordinary"
try:
    Path("/workspaces/.scratch/outside/denied").write_text("escape")
    raise AssertionError("write escaped Workspace")
except OSError:
    pass
try:
    Path("/workspaces/.scratch/.aws/credentials").read_text()
    raise AssertionError("credential was readable")
except OSError:
    pass
try:
    socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    raise AssertionError("restricted network socket opened")
except PermissionError:
    pass
assert not Path("/proc/1/environ").read_bytes().find(b"SYNERGY_EXECUTION_TOKEN=") >= 0
print(Path("allowed").read_text(), end="")
`,
          ],
          workspace: "/workspaces/.scratch/selected",
          sandboxMode: "workspace_write",
          networkMode: "restricted",
          extraReadRoots: Object.values(inputs.paths),
        })
        expect(wrapper.sandboxed).toBe(true)
        let sandboxed = await EnvironmentExecution.start({
          id: "sandboxed",
          scopeID: "scope",
          environmentID: environment.id,
          command: {
            command: wrapper.command,
            args: wrapper.args,
            sandboxID: wrapper.id,
            cwd: "/workspaces/.scratch/selected",
            env: { PATH: "/usr/bin:/bin" },
            writableRoots: wrapper.writeFootprint?.kind === "roots" ? wrapper.writeFootprint.roots : null,
          },
        })
        for (let i = 0; sandboxed.state !== "exited" && i < 300; i++) {
          await Bun.sleep(20)
          sandboxed = await EnvironmentExecution.reconcile(sandboxed.id, "scope")
        }
        const sandboxOutput = (await EnvironmentExecution.output(sandboxed.id, "scope"))
          .filter((chunk) => chunk.stream === "stdout")
          .map((chunk) => Buffer.from(chunk.data, "base64").toString())
          .join("")
        if (sandboxOutput !== "contained")
          throw new Error(
            (await EnvironmentExecution.output(sandboxed.id, "scope"))
              .map((chunk) => Buffer.from(chunk.data, "base64").toString())
              .join(""),
          )
        expect(sandboxOutput).toBe("contained")
        expect(sandboxed.status?.exitCode).toBe(0)
        await EnvironmentExecution.complete(sandboxed.id, "scope")
        await executor.releaseSandbox!(wrapper.id)
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
      id: "fixture-docker",
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
        provider: provider.id,
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
        const observed = await WorkspaceMounts.connect(mounted)
        const before = await observed.observe!(WorkspaceMounts.reference(mounted))
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
        const observationDeadline = Date.now() + 5000
        while ((await observed.observe!(WorkspaceMounts.reference(mounted))).version === before.version) {
          if (Date.now() > observationDeadline) throw new Error("Docker Workspace observation did not advance")
          await Bun.sleep(20)
        }
        failUploads = true
        await expect(EnvironmentExecution.complete(operation.id, "scope")).rejects.toThrow("object store unavailable")
        expect((await EnvironmentExecution.get(operation.id, "scope")).state).toBe("unsaved")
        await expect(Environment.deallocate(environment.id, { scopeID: "scope" })).rejects.toMatchObject({
          name: "EnvironmentBusy",
        })
        await expect(WorkspaceContent.read(selection, "source")).rejects.toThrow("active mount")
        failUploads = false
        await EnvironmentExecution.complete(operation.id, "scope")
        failUploads = true
        await expect(WorkspaceMounts.detach(selection)).rejects.toThrow("object store unavailable")
        expect((await WorkspaceCatalog.get(workspace.id, "scope")).activeMount?.state).toBe("saving")
        await expect(Environment.deallocate(environment.id, { scopeID: "scope" })).rejects.toMatchObject({
          name: "EnvironmentBusy",
        })
        failUploads = false
        await WorkspaceMounts.detach(selection)
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

test.skipIf(!image)(
  "session terminals and user shell share the selected Docker Environment and recoverable Workspace",
  async () => {
    const provider = dockerEnvironment({
      id: "fixture-docker",
      endpoint: process.env.SYNERGY_TEST_DOCKER_HOST ?? "unix:///var/run/docker.sock",
    })
    await using runtime = await localRuntime({
      register() {
        EnvironmentProviders.register(provider)
        WorkspaceBlobs.register("fixture", {
          put: (hash, bytes) => Storage.writeBinary(["test_workspace_blob", hash], bytes),
          get: (hash) => Storage.readBinary(["test_workspace_blob", hash]),
        })
      },
    })
    await runtime.run(async () => {
      await using tmp = await tmpdir()
      await ScopeContext.provide({
        scope: await tmp.scope(),
        workspace: null,
        async fn() {
          const scopeID = ScopeContext.current.scope.id
          const environment = await Environment.bind({
            scopeID,
            ownerID: "terminal",
            provider: provider.id,
            spec: { image: image! },
          })
          const workspace = await WorkspaceCatalog.create({
            scopeID,
            backend: { provider: "objects", spec: { blobStore: "fixture" } },
          })
          const selection = { scopeID, workspaceID: workspace.id }
          const session = await Session.create({ workspaceID: workspace.id, environmentID: environment.id })
          try {
            const terminal = await Pty.create({
              sessionID: session.id,
              command: "/usr/bin/python3",
              args: [
                "-u",
                "-c",
                "import sys; from pathlib import Path; value=sys.stdin.readline(); Path('result').write_text(value); print('保存完成')",
              ],
            })
            expect(terminal.pid).toBeUndefined()
            expect(terminal.environmentID).toBe(environment.id)
            expect(terminal.workspaceID).toBe(workspace.id)
            const connection = Pty.connect(terminal.id, { readyState: 1, send() {}, close() {} })!
            connection.onClose()
            await expect(Environment.deallocate(environment.id, { scopeID })).rejects.toMatchObject({
              name: "EnvironmentBusy",
            })
            await Pty.update(terminal.id, { size: { cols: 120, rows: 35 } })
            const closed = Promise.withResolvers<void>()
            let output = ""
            Pty.connect(terminal.id, {
              readyState: 1,
              send(data) {
                output += data
              },
              close: closed.resolve,
            })
            Pty.write(terminal.id, "terminal-content\n")
            await closed.promise
            expect(output).toContain("保存完成")
            await WorkspaceMounts.detach(selection)
            expect(new TextDecoder().decode(await WorkspaceContent.read(selection, "result"))).toBe(
              "terminal-content\n",
            )
            const response = await shell({
              sessionID: session.id,
              agent: "synergy",
              model: { providerID: "test", modelID: "test" },
              command: "cat result; printf shell-content >> result",
            })
            expect(
              response.parts.some(
                (part) =>
                  part.type === "tool" &&
                  part.state.status === "completed" &&
                  part.state.output === "terminal-content\n",
              ),
            ).toBe(true)
            {
              await using resources = await EnvironmentResources.resolve({
                ...selection,
                environmentID: environment.id,
                needs: { workspace: true },
              })
              await WorkspaceState.provide(
                { id: workspace.id, generation: workspace.binding.generation, scopeID },
                () =>
                  EnvironmentResources.provide(resources, "workbench", async () => {
                    await WorkspaceFileService.createDirectory({ path: "created/child", createParents: true })
                    await WorkspaceFileService.write({
                      path: "created/child/file.txt",
                      content: "panel",
                      encoding: "utf-8",
                      createParents: false,
                      conflictPolicy: "fail",
                      expectedVersion: null,
                    })
                    const created = await WorkspaceFileService.node("created")
                    await WorkspaceFileService.copy({
                      from: "created",
                      to: "copied",
                      expectedVersion: created.entryVersion!,
                    })
                    const command = await WorktreeProcess.run({
                      command: ["/bin/sh", "-c", "printf command >> copied/child/file.txt"],
                      directory: resources.directory!,
                      roots: [resources.directory!],
                    })
                    expect(command.exitCode).toBe(0)
                    const content = await WorkspaceFileService.read({ path: "copied/child/file.txt", mode: "document" })
                    expect(content.kind === "text" && content.content).toBe("panelcommand")
                    expect(
                      (await WorkspaceFileService.children({ path: "copied/child" })).children.map(
                        (entry) => entry.name,
                      ),
                    ).toEqual(["file.txt"])
                  }),
              )
              const context = {
                sessionID: session.id,
                messageID: "msg_files",
                agent: "synergy",
                abort: AbortSignal.any([]),
                ask: async () => {},
                metadata() {},
                resources,
              }
              const read = await (
                await ViewFileTool.init()
              ).execute({ filePath: "result" }, { ...context, callID: "read" })
              expect(read.output).toContain("shell-content")
              await (
                await EditTool.init()
              ).execute(
                { filePath: "result", oldString: "shell-content", newString: "edited-content" },
                { ...context, callID: "edit" },
              )
              const attached = await (
                await AttachTool.init()
              ).execute({ file_path: "result" }, { ...context, callID: "attach" })
              expect(await Bun.file(attached.attachments![0]!.localPath!).text()).toBe(
                "terminal-content\nedited-content",
              )
            }
            await Environment.deallocate(environment.id, { scopeID })
            expect(new TextDecoder().decode(await WorkspaceContent.read(selection, "result"))).toBe(
              "terminal-content\nedited-content",
            )
          } finally {
            await Pty.removeForSession(session.id)
            const current = await Environment.get(environment.id, scopeID)
            if (current.allocation) await provider.deallocate(Environment.requestOf(current))
          }
        },
      })
    })
  },
  120_000,
)

test.skipIf(!image)(
  "restarting the controller saves an existing Docker result without executing it again",
  async () => {
    const provider = dockerEnvironment({
      id: "fixture-docker",
      endpoint: process.env.SYNERGY_TEST_DOCKER_HOST ?? "unix:///var/run/docker.sock",
    })
    await using home = await runtimeHome()
    const register = () => {
      EnvironmentProviders.register(provider)
      WorkspaceBlobs.register("fixture", {
        put: (hash, bytes) => Storage.writeBinary(["test_workspace_blob", hash], bytes),
        get: (hash) => Storage.readBinary(["test_workspace_blob", hash]),
      })
    }
    const first = await testRuntime({ home: home.host.home, register })
    let environmentID = "",
      workspaceID = ""
    try {
      await first.run(async () => {
        environmentID = (
          await Environment.bind({
            scopeID: "scope",
            ownerID: "restart",
            provider: provider.id,
            spec: { image: image! },
          })
        ).id
        workspaceID = (
          await WorkspaceCatalog.create({
            scopeID: "scope",
            backend: { provider: "objects", spec: { blobStore: "fixture" } },
          })
        ).id
        await using resources = await EnvironmentResources.resolve({
          scopeID: "scope",
          environmentID,
          workspaceID,
          needs: { execution: "exec" },
        })
        let execution = await EnvironmentExecution.start({
          id: "recover-result",
          scopeID: "scope",
          environmentID,
          workspaces: [WorkspaceMounts.reference(resources.workspace!)],
          command: {
            command: "/bin/sh",
            args: ["-c", "printf once >> result; printf completed"],
            cwd: resources.directory!,
            env: {},
            writableRoots: [resources.directory!],
          },
        })
        for (let attempt = 0; execution.state !== "exited" && attempt < 300; attempt++) {
          await Bun.sleep(20)
          execution = await EnvironmentExecution.reconcile(execution.id, "scope")
        }
        expect(execution.state).toBe("exited")
      })
    } finally {
      await first.close()
    }
    await using second = await testRuntime({ home: home.host.home, register })
    await second.run(async () => {
      try {
        expect((await EnvironmentExecution.get("recover-result", "scope")).state).toBe("completed")
        expect(
          (await EnvironmentExecution.output("recover-result", "scope"))
            .map((chunk) => Buffer.from(chunk.data, "base64").toString())
            .join(""),
        ).toBe("completed")
        await Environment.deallocate(environmentID, { scopeID: "scope" })
        expect(new TextDecoder().decode(await WorkspaceContent.read({ workspaceID, scopeID: "scope" }, "result"))).toBe(
          "once",
        )
      } finally {
        const current = await Environment.get(environmentID, "scope")
        if (current.allocation) await provider.deallocate(Environment.requestOf(current))
      }
    })
  },
  120_000,
)
