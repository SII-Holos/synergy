import { expect, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceBlobs, WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import { WorkspaceState } from "@ericsanchezok/synergy-harness/workspace/state"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Ripgrep } from "../../src/file/ripgrep"
import { FileView } from "../../src/file/view"
import { WorkspaceFileSearch } from "../../src/workspace-file/search"
import { ScanFilesTool } from "../../src/tools/scan-files"
import { GlobTool } from "../../src/tools/glob"
import { GrepTool } from "../../src/tools/grep"
import { ListTool } from "../../src/tools/ls"

test("search reads selected Workspace bytes, preserves regex and ignore semantics, and needs no dormant compute", async () => {
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
        const selection = { scopeID: workspace.scopeID, workspaceID: workspace.id }
        const environment = await Environment.bind({
          scopeID: workspace.scopeID,
          ownerID: "owner",
          provider: "native",
          spec: {},
        })
        for (const [path, content] of Object.entries({
          ".gitignore": "ignored/\n*.generated.ts\n",
          "src/main.ts": "const 中文 = 42\nconst second = 7\n",
          "src/no.generated.ts": "const excluded = 99\n",
          "src/.ignore": "hidden.ts\n",
          "src/hidden.ts": "const hidden = 88\n",
          "ignored/file.ts": "const ignored = 99\n",
        }))
          await WorkspaceContent.write(selection, {
            path,
            data: new TextEncoder().encode(content),
            expectedVersion: null,
          })
        await WorkspaceContent.mutate(selection, { kind: "mkdir", path: "empty" })
        for (const live of [false, true]) {
          await using resources = await EnvironmentResources.resolve({
            ...selection,
            environmentID: environment.id,
            needs: live ? { execution: "exec" } : { workspace: true },
          })
          await WorkspaceState.provide(
            { id: workspace.id, scopeID: workspace.scopeID, generation: workspace.binding.generation },
            () =>
              EnvironmentResources.provide(resources, live ? "live" : "dormant", async () => {
                const files = await Array.fromAsync(Ripgrep.files({ cwd: FileView.directory(), glob: ["*.ts"] }))
                expect(files).toEqual(["src/main.ts", "src/no.generated.ts", "src/hidden.ts"].sort())
                const defaults = await Array.fromAsync(Ripgrep.files({ cwd: FileView.directory() }))
                expect(defaults).toContain("src/main.ts")
                expect(defaults).not.toContain("src/no.generated.ts")
                expect(defaults).not.toContain("src/hidden.ts")
                const matches = await Array.fromAsync(
                  Ripgrep.matches({
                    cwd: FileView.directory(),
                    pattern: "(?m)^const \\p{Han}+ = (?P<number>\\d+)$",
                    sortPath: true,
                  }),
                )
                expect(matches).toHaveLength(1)
                expect(matches[0]!.path.text.replaceAll("\\", "/").endsWith("src/main.ts")).toBe(true)
                expect(matches[0]!.submatches[0]!.end).toBe(Buffer.byteLength("const 中文 = 42"))
                const content = await WorkspaceFileSearch.search({ kind: "content", query: "中文" })
                expect(content.items.map((item) => item.path)).toEqual(["src/main.ts"])
                const context = {
                  sessionID: "session",
                  messageID: "message",
                  callID: live ? "live-scan" : "dormant-scan",
                  agent: "fixture",
                  abort: AbortSignal.any([]),
                  ask: async () => {},
                  metadata() {},
                  resources,
                }
                const scan = await (await ScanFilesTool.init()).execute({ pattern: "second = 7" }, context)
                expect(scan.output).toContain("second = 7")
                expect(scan.output).toContain("src/main.ts#")
                const glob = await (
                  await GlobTool.init()
                ).execute({ pattern: "*.ts", path: "src" }, { ...context, callID: "glob" })
                expect(glob.output).toContain("src/main.ts")
                const grep = await (
                  await GrepTool.init()
                ).execute({ pattern: "second", path: "src" }, { ...context, callID: "grep" })
                expect(grep.output).toContain("second = 7")
                const list = await (await ListTool.init()).execute({ path: "src" }, { ...context, callID: "list" })
                expect(list.output).toContain("main.ts")
                await expect(
                  Array.fromAsync(Ripgrep.matches({ cwd: FileView.directory(), paths: ["empty"], pattern: "(" })),
                ).rejects.toThrow("regex parse error")
              }),
          )
          expect((await Environment.get(environment.id, workspace.scopeID)).state).toBe(live ? "ready" : "idle")
        }
        await Environment.deallocate(environment.id, { scopeID: workspace.scopeID })
      },
    }),
  )
}, 30_000)
