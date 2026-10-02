import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import { expect, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceBlobs, WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import { WorkspaceState } from "@ericsanchezok/synergy-harness/workspace/state"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { EnvironmentProcess } from "@ericsanchezok/synergy-harness/environment/process"
import { EnvironmentExecution } from "@ericsanchezok/synergy-harness/environment/execution"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { RolloutTool } from "@ericsanchezok/synergy-harness/session/rollout/tool"
import { Snapshot } from "@ericsanchezok/synergy-harness/session/snapshot"
import { FileView } from "../../src/file/view"
import { WorkspaceMounts } from "@ericsanchezok/synergy-harness/workspace/mount"
import { WorkspaceTree } from "@ericsanchezok/synergy-harness/workspace/tree"

for (const live of [false, true])
  test(`object Workspace history captures and restores ${live ? "live" : "dormant"} writes without a controller directory`, async () => {
    await using runtime = await testRuntime({
      register() {
        WorkspaceBlobs.register("history", {
          put: (hash, bytes) => Storage.writeBinary(["history", hash], bytes),
          get: (hash) => Storage.readBinary(["history", hash]),
        })
      },
    })
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          const scopeID = Scope.home().id
          const workspace = await WorkspaceCatalog.create({
            scopeID,
            backend: { provider: "objects", spec: { blobStore: "history" } },
          })
          const environment = await Environment.bind({ scopeID, ownerID: "history", provider: "native", spec: {} })
          const session = await Session.create({ workspaceID: workspace.id, environmentID: environment.id })
          const user = await Session.updateMessage({
            id: Identifier.ascending("message"),
            sessionID: session.id,
            role: "user",
            time: { created: Date.now() },
            agent: PrimaryAgentIdentity.names.general,
            model: { providerID: "test", modelID: "test" },
          })
          const assistant = await Session.updateMessage({
            id: Identifier.ascending("message"),
            sessionID: session.id,
            parentID: user.id,
            rootID: user.id,
            role: "assistant",
            providerID: "test",
            modelID: "test",
            mode: PrimaryAgentIdentity.names.general,
            agent: PrimaryAgentIdentity.names.general,
            time: { created: Date.now() },
            path: { cwd: null, root: null },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          })
          await using resources = await EnvironmentResources.resolve({
            scopeID,
            workspaceID: workspace.id,
            environmentID: environment.id,
            needs: live ? { execution: "exec" } : { workspace: true },
          })
          await WorkspaceState.provide({ id: workspace.id, scopeID, generation: workspace.binding.generation }, () =>
            EnvironmentResources.provide(resources, `history-${live}`, async () => {
              const initial = new TextEncoder().encode("initial\n")
              await FileView.write("file.txt", initial, null)
              await RolloutTool.execute(
                {
                  owner: { kind: "session", scopeID, sessionID: session.id },
                  runID: user.id,
                  messageID: assistant.id,
                  toolCallID: "edit",
                  tool: "write",
                  args: {},
                },
                async () => {
                  await FileView.write(
                    "file.txt",
                    new TextEncoder().encode("owned edit\n"),
                    `sha256:${WorkspaceTree.hash(initial)}`,
                  )
                  await FileView.write("second.txt", new TextEncoder().encode("second edit\n"), null)
                  return "written"
                },
              )
              const parts = (await MessageV2.get({ sessionID: session.id, messageID: assistant.id })).parts.filter(
                (part): part is MessageV2.PatchPart => part.type === "patch",
              )
              expect(parts).toHaveLength(2)
              const part = parts[0]!
              expect(part.operation?.status).toBe("complete")
              expect(part.workspace?.id).toBe(workspace.id)
              expect(part.files).toEqual(["file.txt"])
              if (part.operation?.status !== "complete") throw new Error("history incomplete")
              const diff = await Snapshot.diffSummary(part.hash, part.operation.afterHash, session.id)
              expect(diff[0]?.patch).toContain("+owned edit")
              expect(await Session.diff(session.id)).toHaveLength(2)
              const restored = await Snapshot.revert(parts, session.id)
              expect(restored.failedFiles).toEqual([])
              expect(restored.restoredFiles).toEqual(["file.txt", "second.txt"])
              expect(new TextDecoder().decode(await FileView.bytes("file.txt"))).toBe("initial\n")
              expect(await FileView.stat("second.txt")).toBeUndefined()
            }),
          )
          await resources.release()
          await Environment.deallocate(environment.id, { scopeID })
        },
      }),
    )
  }, 30_000)

test("execution history survives a failed save and includes only explicitly referenced mounted Workspaces", async () => {
  let failSave = false
  await using runtime = await testRuntime({
    register() {
      WorkspaceBlobs.register("history", {
        async put(hash, bytes) {
          if (failSave) throw new Error("object store unavailable")
          await Storage.writeBinary(["history", hash], bytes)
        },
        get: (hash) => Storage.readBinary(["history", hash]),
      })
    },
  })
  await runtime.run(async () => {
    const scopeID = Scope.home().id
    const environment = await Environment.bind({ scopeID, ownerID: "history", provider: "native", spec: {} })
    const first = await WorkspaceCatalog.create({
      scopeID,
      backend: { provider: "objects", spec: { blobStore: "history" } },
    })
    const second = await WorkspaceCatalog.create({
      scopeID,
      backend: { provider: "objects", spec: { blobStore: "history" } },
    })
    const bytes = new TextEncoder().encode("before")
    for (const workspace of [first, second])
      await WorkspaceContent.write(
        { scopeID, workspaceID: workspace.id },
        { path: "same.txt", data: bytes, expectedVersion: null },
      )
    await using resources = await EnvironmentResources.resolve({
      scopeID,
      workspaceID: first.id,
      environmentID: environment.id,
      needs: { execution: "exec" },
    })
    await using other = await EnvironmentResources.resolve({
      scopeID,
      workspaceID: second.id,
      environmentID: environment.id,
      needs: { execution: "exec" },
    })
    const owner = await ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspaceID: first.id, environmentID: environment.id })
        const user = await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: PrimaryAgentIdentity.names.general,
          model: { providerID: "test", modelID: "test" },
        })
        const assistant = await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: session.id,
          parentID: user.id,
          rootID: user.id,
          role: "assistant",
          providerID: "test",
          modelID: "test",
          mode: PrimaryAgentIdentity.names.general,
          agent: PrimaryAgentIdentity.names.general,
          time: { created: Date.now() },
          path: { cwd: null, root: null },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        })
        await RolloutTool.execute(
          {
            owner: { kind: "session", scopeID, sessionID: session.id },
            runID: user.id,
            messageID: assistant.id,
            toolCallID: "bash",
            tool: "bash",
            args: {},
          },
          async () => {
            const execution = await EnvironmentProcess.prepare({
              id: "history-execution",
              workspaces: [WorkspaceMounts.reference(other.workspace!)],
              scopeID,
              resources,
              command: {
                command: process.execPath,
                args: [
                  "-e",
                  "for (const root of process.argv.slice(1)) await Bun.write(root + '/same.txt', 'after')",
                  resources.directory!,
                  other.directory!,
                ],
                cwd: resources.directory!,
                env: {},
                useRoots: [other.directory!],
              },
            })
            execution.child.stdout.resume()
            execution.child.stderr.resume()
            failSave = true
            await execution.activate()
            await expect(execution.completion).rejects.toMatchObject({ name: "EnvironmentProcessError" })
            return "saving failed"
          },
        )
        return { session, assistant }
      },
    })
    const pending = await EnvironmentExecution.get("history-execution", scopeID)
    expect(pending.state).toBe("unsaved")
    expect(pending.status?.before).toHaveLength(2)
    expect(pending.evidence).toHaveLength(2)
    failSave = false
    await EnvironmentExecution.complete("history-execution", scopeID)
    await resources.release()
    await other.release()
    await Environment.deallocate(environment.id, { scopeID })
    await ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const parts = (
          await MessageV2.get({ sessionID: owner.session.id, messageID: owner.assistant.id })
        ).parts.filter((part): part is MessageV2.PatchPart => part.type === "patch")
        expect(parts).toHaveLength(2)
        for (const part of parts) {
          expect(part.operation?.status).toBe("complete")
          expect(part.files).toEqual(["same.txt"])
        }
        for (const workspace of [first, second])
          expect(
            new TextDecoder().decode(await WorkspaceContent.read({ scopeID, workspaceID: workspace.id }, "same.txt")),
          ).toBe("after")
        const result = await Snapshot.revert(parts, owner.session.id)
        expect(result.failedFiles).toEqual([])
        expect(result.restoredFiles).toHaveLength(2)
        for (const workspace of [first, second])
          expect(
            new TextDecoder().decode(await WorkspaceContent.read({ scopeID, workspaceID: workspace.id }, "same.txt")),
          ).toBe("before")
      },
    })
  })
}, 30_000)
