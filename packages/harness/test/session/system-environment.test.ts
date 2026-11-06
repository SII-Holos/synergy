import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { SystemPrompt } from "../../src/session/system"
import { WorkspaceBinding } from "../../src/workspace/binding"
import { WorkspaceCatalog } from "../../src/workspace/catalog"
import { testRuntime } from "../support/runtime"
import { configureRuntimeEndpoint } from "../../src/util/runtime-endpoint"
import { RuntimeAdvisory } from "../../src/session/runtime-context"
import { RuntimeHandle } from "../../src/lifecycle/runtime"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { runtimeHome } from "../support/runtime-home"

test("runtime identity is stable, Runtime-local and separate from the session Workspace", async () => {
  await using first = await testRuntime({ env: { SYNERGY_SERVER_TOKEN: "secret-not-for-the-model" } })
  await using second = await testRuntime()
  const firstText = await first.run(() => {
    configureRuntimeEndpoint({ hostname: "127.0.0.1", port: 45171, generation: "first-listener" })
    return SystemPrompt.runtime()
  })
  const secondText = await second.run(() => {
    configureRuntimeEndpoint({ hostname: "0.0.0.0", port: 45172, generation: "second-listener" })
    return SystemPrompt.runtime()
  })
  expect(firstText).toContain("<synergy-runtime>")
  expect(firstText).toContain("Runtime mode: oneshot")
  expect(firstText).toContain(`Runtime home: ${first.host.home}`)
  expect(firstText).toContain(`Data root: ${first.host.root}`)
  expect(firstText).toContain("Backend URL: http://127.0.0.1:45171")
  expect(firstText).toContain("Listener generation: first-listener")
  expect(firstText).not.toContain("secret-not-for-the-model")
  expect(secondText).toContain("Backend URL: http://127.0.0.1:45172")
  expect(secondText).toContain("Listener generation: second-listener")
  expect(secondText).not.toContain(first.host.home)
  expect(await first.run(() => SystemPrompt.runtime())).toBe(firstText)
  expect(await second.run(() => SystemPrompt.runtime())).toBe(secondText)
  await first.run(async () => {
    const { scope } = await Scope.fromDirectory(first.host.home)
    await ScopeContext.provide({
      scope,
      workspace: null,
      fn: async () => {
        expect(SystemPrompt.runtime()).toBe(firstText)
        expect((await SystemPrompt.environment()).join("\n")).not.toContain("<synergy-runtime>")
      },
    })
    configureRuntimeEndpoint(undefined)
    expect(SystemPrompt.runtime()).toContain("Backend URL: none (this Runtime has no HTTP listener)")
    expect(SystemPrompt.runtime()).not.toContain("45171")
  })
  expect(await second.run(() => SystemPrompt.runtime())).toBe(secondText)
  const observation = RuntimeAdvisory.prepare({
    scope: "same-session",
    sources: [RuntimeAdvisory.present("synergy-runtime", firstText)],
    previous: [],
  })!
  expect(
    RuntimeAdvisory.prepare({
      scope: "same-session",
      sources: [RuntimeAdvisory.present("synergy-runtime", firstText)],
      previous: [observation.metadata],
    }),
  ).toBeUndefined()
  const switched = RuntimeAdvisory.prepare({
    scope: "same-session",
    sources: [RuntimeAdvisory.present("synergy-runtime", secondText)],
    previous: [observation.metadata],
  })!
  expect(switched.text).toContain(secondText)
  expect(switched.text).not.toContain(firstText)
})

test("runtime identity uses the actual ephemeral listener and refreshes after restarting the same Home", async () => {
  await using fixture = await runtimeHome()
  const open = () =>
    RuntimeHandle.open({
      host: {
        ...fixture.host,
        launch: {
          entry: "dev-web" as const,
          distribution: "source" as const,
          version: "fixture",
          channel: "local",
          sourceCheckout: "/runtime/source",
          revision: "a".repeat(40),
        },
      },
      mode: "oneshot",
      network: { hostname: "127.0.0.1", port: 0 },
      composition: {
        register() {},
        services: () => ({
          transport: {
            closeAdmission() {},
            listen: (network) => Bun.serve({ ...network, fetch: () => new Response("fixture") }),
          },
        }),
      },
      storage: {
        kind: "owned",
        async open() {
          const store = await TransactionalStore.open({
            backend: "sqlite",
            filename: path.join(fixture.host.root, "authority.sqlite"),
            namespace: "identity",
          })
          return {
            handle: { store, artifactDirectory: path.join(fixture.host.root, "data") },
            needsValidation: false,
            async activate() {},
          }
        },
      },
    })
  await using first = await open()
  const before = first.run(() => SystemPrompt.runtime())
  expect(first.server!.port).toBeGreaterThan(0)
  expect(before).toContain(`Backend URL: http://127.0.0.1:${first.server!.port}`)
  expect(before).toContain("Launch entry: bun dev web")
  expect(before).toContain("Runtime source checkout: /runtime/source")
  expect(before).not.toContain("Backend URL: http://127.0.0.1:0")
  await first.close()
  await using restarted = await open()
  const after = restarted.run(() => SystemPrompt.runtime())
  expect(after).toContain(`Runtime home: ${fixture.host.home}`)
  expect(after).toContain(`Backend URL: http://127.0.0.1:${restarted.server!.port}`)
  expect(after).not.toBe(before)
  expect(() => first.run(() => SystemPrompt.runtime())).toThrow("closed")
}, 30_000)

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
