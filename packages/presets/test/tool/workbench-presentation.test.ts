import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { testRuntime } from "../support/runtime"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { ToolInvocation } from "@ericsanchezok/synergy-harness/tools"
import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import { EnforcementError } from "@ericsanchezok/synergy-harness/enforcement/errors"
import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"

const env = {
  SYNERGY_CONFIG_CONTENT: JSON.stringify({
    enabled_providers: ["fixture"],
    model: "fixture/presentation",
    provider: {
      fixture: {
        npm: "@ai-sdk/openai-compatible",
        env: [],
        options: { baseURL: "http://127.0.0.1:1/v1", apiKey: "fixture-only" },
        models: { presentation: { name: "Fixture", tool_call: true, limit: { context: 1048576, output: 65536 } } },
      },
    },
  }),
}

async function invocation(permission?: PermissionNext.Ruleset, workspaceID?: string) {
  const session = await Session.create({
    controlProfile: "autonomous",
    permission,
    ...(workspaceID ? { workspaceID } : { workspace: ScopeContext.tryWorkspace() ?? null }),
  })
  const agent = PrimaryAgentIdentity.names.general
  const parent = await Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID: session.id,
    role: "user",
    agent,
    model: { providerID: "fixture", modelID: "presentation" },
    time: { created: Date.now() },
  })
  const assistant = await Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID: session.id,
    role: "assistant",
    parentID: parent.id,
    rootID: parent.id,
    time: { created: Date.now() },
    modelID: "presentation",
    providerID: "fixture",
    mode: "fixture",
    agent,
    path: { cwd: ScopeContext.tryWorkspace()?.path ?? null, root: ScopeContext.tryWorkspace()?.path ?? null },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  return (input: Record<string, unknown>) =>
    ToolInvocation.invoke({
      sessionID: session.id,
      messageID: assistant.id,
      agent,
      tool: "workbench_view",
      args: { input },
      signal: new AbortController().signal,
    })
}

test("registered presentation keeps status workspace-independent but classifies a file against its actual captured root", async () => {
  await using runtime = await testRuntime({ env })
  await runtime.run(async () => {
    await ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      async fn() {
        const invoke = await invocation()
        expect((await invoke({ action: "status" })).metadata.status).toBe("unavailable")
      },
    })
    const directory = path.join(runtime.host.root, "data", "auth")
    await mkdir(directory, { recursive: true })
    await Bun.write(path.join(directory, "presentation-source.txt"), "Synthetic protected resource\n")
    const { scope } = await Scope.fromDirectory(directory)
    await ScopeContext.provide({
      scope,
      async fn() {
        const invoke = await invocation()
        await expect(
          invoke({ action: "open", target: { kind: "workspace-file", path: "presentation-source.txt" } }),
        ).rejects.toBeInstanceOf(EnforcementError.PolicyDenied)
      },
    })
  })
}, 30000)

test("registered presentation enforces read denials on the resolved file rather than only the display tool name", async () => {
  await using runtime = await testRuntime({ env })
  await runtime.run(async () => {
    const directory = path.join(runtime.host.root, "project")
    await mkdir(directory, { recursive: true })
    const filename = path.join(directory, "source.txt")
    await Bun.write(filename, "Synthetic readable file\n")
    const { scope } = await Scope.fromDirectory(directory)
    await ScopeContext.provide({
      scope,
      async fn() {
        const resolved = path.join(ScopeContext.current.directory, "source.txt")
        const invoke = await invocation(PermissionNext.fromConfig({ read: { [resolved]: "deny" } }))
        await expect(
          invoke({ action: "open", target: { kind: "workspace-file", path: "source.txt" } }),
        ).rejects.toBeInstanceOf(PermissionNext.DeniedError)
      },
    })
  })
}, 30000)

test("registered presentation captures object Workspaces without a native Session projection and retains read denial", async () => {
  await using runtime = await testRuntime({ env })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      async fn() {
        for (const virtualRoot of [undefined, "/workspace"]) {
          const workspace = await WorkspaceCatalog.create({
            scopeID: "home",
            backend: { provider: "objects", spec: { blobStore: "fixture", ...(virtualRoot ? { virtualRoot } : {}) } },
          })
          expect(WorkspaceCatalog.projection(workspace)).toBeNull()
          const invoke = await invocation(undefined, workspace.id)
          const target = { action: "open", target: { kind: "workspace-file", path: "source.txt" } }
          expect((await invoke(target)).metadata).toMatchObject({
            status: "unavailable",
            reason: "No ready frontend supporting this target is actively showing this Scope and Session.",
          })
          const denied = await invocation(
            PermissionNext.fromConfig({ read: { [virtualRoot ? `${virtualRoot}/source.txt` : "source.txt"]: "deny" } }),
            workspace.id,
          )
          await expect(denied(target)).rejects.toBeInstanceOf(PermissionNext.DeniedError)
        }
      },
    }),
  )
}, 30000)
