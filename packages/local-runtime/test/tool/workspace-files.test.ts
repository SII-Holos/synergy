import { AttachmentDiscovery } from "../../src/tools/attachment-discovery"
import { ViewImageTool } from "../../src/tools/view-image"
import { expect, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceBlobs, WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { ViewFileTool } from "../../src/tools/view-file"
import { EditTool } from "../../src/tools/edit"
import { SaveFileTool } from "../../src/tools/save-file"

test("file tools share dormant object and live execution views without a local Scope directory", async () => {
  await using runtime = await testRuntime({
    register() {
      WorkspaceBlobs.register("fixture", {
        put: (hash, bytes) => Storage.writeBinary(["fixture", hash], bytes),
        get: (hash) => Storage.readBinary(["fixture", hash]),
      })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const workspace = await WorkspaceCatalog.create({
          scopeID: Scope.home().id,
          backend: { provider: "objects", spec: { blobStore: "fixture" } },
        })
        const environment = await Environment.bind({
          scopeID: workspace.scopeID,
          ownerID: "owner",
          provider: "native",
          spec: {},
        })
        const selection = { scopeID: workspace.scopeID, workspaceID: workspace.id, environmentID: environment.id }
        const context = {
          sessionID: "fixture",
          messageID: "message",
          agent: "fixture",
          abort: AbortSignal.any([]),
          ask: async () => {},
          metadata() {},
        }
        {
          await using resources = await EnvironmentResources.resolve({ ...selection, needs: { workspace: true } })
          await (
            await SaveFileTool.init()
          ).execute(
            { filePath: "src/file.ts", content: "const value = 1\n" },
            { ...context, callID: "create", resources },
          )
          const viewed = await (
            await ViewFileTool.init()
          ).execute({ filePath: "src/file.ts" }, { ...context, callID: "view", resources })
          expect(viewed.output).toContain("const value = 1")
          await (
            await EditTool.init()
          ).execute(
            { filePath: "src/file.ts", oldString: "value = 1", newString: "value = 2" },
            { ...context, callID: "edit", resources },
          )
          const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>'
          await (
            await SaveFileTool.init()
          ).execute({ filePath: "preview.svg", content: svg }, { ...context, callID: "image", resources })
          const discovered = await EnvironmentResources.provide(resources, "discovery", () =>
            AttachmentDiscovery.discover({
              output: "![preview](./preview.svg)",
              cwd: "",
              sessionID: context.sessionID,
              messageID: context.messageID,
              tool: "bash",
            }),
          )
          expect(discovered).toHaveLength(1)
          expect(await Bun.file(discovered[0]!.localPath!).text()).toBe(svg)
          const image = await (
            await ViewImageTool.init()
          ).execute({ filePath: "preview.svg" }, { ...context, callID: "view-image", resources })
          expect(image.attachments?.[0]?.url).toBe(discovered[0]!.url)
          expect(await Bun.file(image.attachments![0]!.localPath!).text()).toBe(svg)
          expect((await Environment.get(environment.id, workspace.scopeID)).state).toBe("idle")
        }
        {
          await using resources = await EnvironmentResources.resolve({ ...selection, needs: { execution: "exec" } })
          const viewed = await (
            await ViewFileTool.init()
          ).execute({ filePath: "src/file.ts" }, { ...context, callID: "live-read", resources })
          expect(viewed.output).toContain("const value = 2")
          await (
            await EditTool.init()
          ).execute(
            { filePath: "src/file.ts", oldString: "value = 2", newString: "value = 3" },
            { ...context, callID: "live-edit", resources },
          )
          await expect(
            (await SaveFileTool.init()).execute({ filePath: "../escape", content: "never" }, { ...context, resources }),
          ).rejects.toThrow()
        }
        await Environment.deallocate(environment.id, { scopeID: workspace.scopeID })
        expect(new TextDecoder().decode(await WorkspaceContent.read(selection, "src/file.ts"))).toBe(
          "const value = 3\n",
        )
      },
    }),
  )
}, 30_000)
