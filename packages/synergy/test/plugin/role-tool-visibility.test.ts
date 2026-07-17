import { afterEach, describe, expect, test } from "bun:test"
import { compilePluginManifest, definePlugin, capability } from "@ericsanchezok/synergy-plugin"
import { executePluginHostService } from "../../src/plugin/host-services-runtime"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { tmpdir } from "../fixture/fixture"

const LIGHTLOOP_CAP = "lightloop.delegate"
const BLUEPRINT_CAP = "blueprint.delegate"

describe("LightLoop role-tool Host input acceptance", () => {
  const cleaned: string[] = []
  afterEach(async () => {
    const ids = cleaned.splice(0)
    await Promise.all(ids.map((id) => Session.remove(id).catch(() => {})))
  })

  function trackCleanup(sessionID: string) {
    cleaned.push(sessionID)
  }

  async function setup() {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    const manifest = compilePluginManifest(
      definePlugin({
        id: "lightloop-tool-vis-test",
        version: "1.0.0",
        description: "LightLoop tool visibility test",
        capabilities: [capability(LIGHTLOOP_CAP as any)],
        contributions: [],
      }),
      { generation: "gen-tool-vis" },
    )

    let parentSessionID = ""
    let parentMessageID = ""
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const parent = await Session.create({})
        parentSessionID = parent.id
        parentMessageID = `msg-${parent.id}`
        trackCleanup(parent.id)
      },
    })

    return {
      scope,
      manifest,
      tmp,
      parentSessionID,
      parentMessageID,
      invoke(params: Record<string, unknown>) {
        return executePluginHostService({
          pluginId: manifest.id,
          pluginDir: tmp.path,
          manifest,
          invocation: {
            scopeId: scope.id,
            sessionId: parentSessionID,
            directory: tmp.path,
            actor: { type: "agent", agent: "test-agent", messageId: parentMessageID, callId: "call-1" },
          },
          method: "lightloop.start" as any,
          params,
          signal: AbortSignal.timeout(5000),
        })
      },
    }
  }

  test("executionTools and reviewTools are accepted as valid Host input fields", async () => {
    // The actual startLightLoop will fail due to missing plugin.json/agents,
    // but the contract test proves executionTools is read as a valid field.
    const s = await setup()
    let error: Error | undefined
    try {
      await s.invoke({
        instructions: "test",
        correlationId: "c1",
        executionAgent: "nonexistent",
        reviewAgent: "nonexistent",
        executionTools: { plugin__truthward__context_query: true },
        reviewTools: { plugin__truthward__context_query: true, plugin__truthward__n03_artifact_get: true },
        budget: { maxRuntimeMs: 10000, maxIterations: 1 },
        parent: { sessionId: s.parentSessionID, messageId: s.parentMessageID },
      })
    } catch (e: any) {
      error = e
    }
    // Must not fail due to old `tools` field being missing.
    expect(error?.message).not.toContain("tools")
  })

  test("lifecycle actor without explicit parent fails with TASK_PARENT_REQUIRED, not tools error", async () => {
    const s = await setup()
    try {
      await executePluginHostService({
        pluginId: s.manifest.id,
        pluginDir: s.tmp.path,
        manifest: s.manifest,
        invocation: {
          scopeId: s.scope.id,
          sessionId: s.parentSessionID,
          directory: s.tmp.path,
          actor: { type: "lifecycle" },
        },
        method: "lightloop.start" as any,
        params: {
          instructions: "test",
          correlationId: "c1",
          executionAgent: "nonexistent",
          reviewAgent: "nonexistent",
          executionTools: { plugin__truthward__context_query: true },
          reviewTools: { plugin__truthward__context_query: true },
          budget: { maxRuntimeMs: 10000, maxIterations: 1 },
        },
        signal: AbortSignal.timeout(5000),
      })
      // Should fail with parent-required, not with tool/parameter errors
      expect.unreachable("should have thrown")
    } catch (e: any) {
      expect(e.message).toContain("requires a parent Session")
    }
  })
})

describe("Blueprint role-tool Host input acceptance", () => {
  const cleaned: string[] = []
  afterEach(async () => {
    const ids = cleaned.splice(0)
    await Promise.all(ids.map((id) => Session.remove(id).catch(() => {})))
  })

  function trackCleanup(sessionID: string) {
    cleaned.push(sessionID)
  }

  async function setup() {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    const manifest = compilePluginManifest(
      definePlugin({
        id: "blueprint-tool-vis-test",
        version: "1.0.0",
        description: "Blueprint tool visibility test",
        capabilities: [capability(BLUEPRINT_CAP as any)],
        contributions: [],
      }),
      { generation: "gen-tool-vis" },
    )

    let parentSessionID = ""
    let parentMessageID = ""
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const parent = await Session.create({})
        parentSessionID = parent.id
        parentMessageID = `msg-${parent.id}`
        trackCleanup(parent.id)
      },
    })

    return {
      scope,
      manifest,
      tmp,
      parentSessionID,
      parentMessageID,
      invoke(params: Record<string, unknown>) {
        return executePluginHostService({
          pluginId: manifest.id,
          pluginDir: tmp.path,
          manifest,
          invocation: {
            scopeId: scope.id,
            sessionId: parentSessionID,
            directory: tmp.path,
            actor: { type: "agent", agent: "test-agent", messageId: parentMessageID, callId: "call-1" },
          },
          method: "blueprint.start" as any,
          params,
          signal: AbortSignal.timeout(5000),
        })
      },
    }
  }

  test("executionTools and auditTools are accepted as valid Host input fields", async () => {
    const s = await setup()
    let error: Error | undefined
    try {
      await s.invoke({
        title: "Test",
        markdown: "# Test",
        sourceDigest: "abc",
        correlationId: "c1",
        executionAgent: "nonexistent",
        auditAgent: "nonexistent",
        executionTools: { plugin__truthward__context_query: true },
        auditTools: { plugin__truthward__context_query: true },
        budget: { maxRuntimeMs: 10000, maxIterations: 1 },
        parent: { sessionId: s.parentSessionID, messageId: s.parentMessageID },
      })
    } catch (e: any) {
      error = e
    }
    // Must not fail with "tools" (old field) or unrecognized field error
    expect(error?.message).not.toContain('"tools"')
  })

  test("lifecycle actor without parent fails with TASK_PARENT_REQUIRED", async () => {
    const s = await setup()
    try {
      await executePluginHostService({
        pluginId: s.manifest.id,
        pluginDir: s.tmp.path,
        manifest: s.manifest,
        invocation: {
          scopeId: s.scope.id,
          sessionId: s.parentSessionID,
          directory: s.tmp.path,
          actor: { type: "lifecycle" },
        },
        method: "blueprint.start" as any,
        params: {
          title: "Test",
          markdown: "# Test",
          sourceDigest: "abc",
          correlationId: "c1",
          executionAgent: "nonexistent",
          auditAgent: "nonexistent",
          executionTools: { plugin__truthward__context_query: true },
          auditTools: { plugin__truthward__context_query: true },
          budget: { maxRuntimeMs: 10000, maxIterations: 1 },
        },
        signal: AbortSignal.timeout(5000),
      })
      expect.unreachable("should have thrown")
    } catch (e: any) {
      expect(e.message).toContain("requires a parent Session")
    }
  })
})
