import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { SystemPrompt } from "../../src/session/system"
import { WorkspaceBinding } from "../../src/workspace/binding"
import { WorkspaceCatalog } from "../../src/workspace/catalog"
import { testRuntime } from "../support/runtime"

test("environment attributes a shared write-root failure without declaring all Workspace files unavailable", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const directory = path.join(runtime.host.home, "main")
    const sharedDirectory = path.join(runtime.host.home, "shared")
    await Promise.all([fs.mkdir(directory), fs.mkdir(sharedDirectory)])
    await Bun.write(path.join(directory, "readable.txt"), "selected Workspace remains readable")
    const { scope } = await Scope.fromDirectory(directory)
    const selected = await WorkspaceBinding.register(scope.id, directory)
    const shared = await WorkspaceBinding.register(scope.id, sharedDirectory)
    const sharing = await WorkspaceCatalog.setSharing(selected.id, {
      scopeID: scope.id,
      expectedRevision: selected.revision,
      workspaceIDs: [shared.id],
    })
    const workspace = WorkspaceCatalog.projection(sharing)!
    const [healthyText] = await ScopeContext.provide({
      scope,
      workspace,
      fn: () => SystemPrompt.environment(),
    })
    expect(healthyText).toContain(`Writable workspace directories: ${workspace.path}, ${shared.binding.path}`)
    expect(healthyText).not.toContain("Workspace write-root validation: failed")

    await fs.rename(sharedDirectory, `${sharedDirectory}-original`)
    await fs.mkdir(sharedDirectory)
    const failure = {
      name: "WorkspaceUnavailable",
      data: { workspaceID: shared.id, reason: "identity_changed" },
    }
    await expect(Scope.Root.executionRoots(scope, workspace)).rejects.toMatchObject(failure)

    const [text] = await ScopeContext.provide({
      scope,
      workspace,
      fn: () => SystemPrompt.environment(),
    })

    expect(text).toContain(`Working directory: ${workspace.path}`)
    expect(text).toContain("Workspace write-root validation: failed")
    expect(text).toContain(`Shared writable Workspace: ${shared.id}`)
    expect(text).toContain(shared.binding.path!)
    expect(text).toContain("identity_changed")
    expect(text).toContain("The Workspace directory was replaced; rebind it before executing")
    expect(text).toContain("API-only work remains available")
    expect(text).not.toContain("Workspace files: unavailable")
    expect(text).not.toContain("Workspace: none")
    expect(text).not.toContain("Writable workspace directories:")
    expect(await Bun.file(path.join(directory, "readable.txt")).text()).toBe("selected Workspace remains readable")
    expect(await WorkspaceBinding.validate(selected.id, scope.id)).toEqual(workspace)
    await expect(Scope.Root.executionRoots(scope, workspace)).rejects.toMatchObject(failure)
    expect(await WorkspaceCatalog.get(selected.id, scope.id)).toEqual(sharing)
    expect(await WorkspaceCatalog.get(shared.id, scope.id)).toEqual(shared)
  })
})

test("environment retains the selected Workspace and reason when its directory is unavailable", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const directory = path.join(runtime.host.home, "selected")
    await fs.mkdir(directory)
    const { scope } = await Scope.fromDirectory(directory)
    const selected = await WorkspaceBinding.register(scope.id, directory)
    const workspace = WorkspaceCatalog.projection(selected)!
    await fs.rename(directory, `${directory}-original`)

    const [text] = await ScopeContext.provide({
      scope,
      workspace,
      fn: () => SystemPrompt.environment(),
    })

    expect(text).toContain("Workspace write-root validation: failed")
    expect(text).toContain(`Selected Workspace: ${selected.id}`)
    expect(text).toContain(workspace.path)
    expect(text).toContain("directory_unavailable")
    expect(text).toContain("The Workspace directory is unavailable")
    expect(text).not.toContain("Shared writable Workspace:")
    expect(text).not.toContain("Workspace: none")
    expect(text).not.toContain("Writable workspace directories:")
    await expect(Scope.Root.executionRoots(scope, workspace)).rejects.toMatchObject({
      name: "WorkspaceUnavailable",
      data: { workspaceID: selected.id, reason: "directory_unavailable" },
    })
    expect(await WorkspaceCatalog.get(selected.id, scope.id)).toEqual(selected)
  })
})

test("environment distinguishes a session without a Workspace from failed write-root validation", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const { scope } = await Scope.fromDirectory(runtime.host.home)
    const [text] = await ScopeContext.provide({
      scope,
      workspace: null,
      fn: () =>
        SystemPrompt.environment({
          session: {
            id: "ses_api_only",
            title: "API only",
            time: { created: 0 },
            workspaceID: null,
            environmentID: null,
          },
        }),
    })

    expect(text).toContain(
      "Workspace: none. File tools require a Workspace; execution tools use the selected Environment.",
    )
    expect(text).toContain("Selected Environment: none")
    expect(text).not.toContain("Workspace write-root validation: failed")
    expect(text).not.toContain("Workspace files: unavailable")
    expect(text).not.toContain("Writable workspace directories:")
    expect(await WorkspaceCatalog.list(scope.id)).toEqual([])
  })
})

test("environment does not suppress Workspace binding-generation errors", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const { scope } = await Scope.fromDirectory(runtime.host.home)
    const selected = await WorkspaceBinding.register(scope.id, runtime.host.home)
    const workspace = WorkspaceCatalog.projection(selected)!

    await expect(
      ScopeContext.provide({
        scope,
        workspace: { ...workspace, generation: workspace.generation! + 1 },
        fn: () => SystemPrompt.environment(),
      }),
    ).rejects.toMatchObject({
      name: "WorkspaceBindingChanged",
      data: { workspaceID: selected.id },
    })
  })
})
