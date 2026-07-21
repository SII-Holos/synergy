import type { PluginHostServiceMethod } from "../../src/plugin-runtime"
import { afterEach, describe, expect, test } from "bun:test"
import { compilePluginManifest, definePlugin, capability } from "@ericsanchezok/synergy-plugin"
import { executePluginHostService } from "../../src/plugin/host-services-runtime"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { tmpdir } from "../fixture/fixture"

const LIGHTLOOP_CAP = "lightloop.delegate"
const BLUEPRINT_CAP = "blueprint.delegate"
const SESSION_READ_CAP = "session.read"
const SESSION_CONTROL_CAP = "session.control"

describe("loop-start parent contract (host runtime)", () => {
  /**
   * Shared test infrastructure: creates a Scope with a real Session
   * (the "parent" session), and compiles a minimal plugin manifest so
   * the capability gate passes.  Each test calls executePluginHostService
   * directly, which exercises the full resolveStartParent → service
   * chain (including Session.get for scope validation).
   */

  const cleaned: string[] = []
  afterEach(async () => {
    const ids = cleaned.splice(0)
    await Promise.all(ids.map((id) => Session.remove(id).catch(() => {})))
  })

  function trackCleanup(sessionID: string) {
    cleaned.push(sessionID)
  }

  async function setup(cap: string) {
    const tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    const manifest = compilePluginManifest(
      definePlugin({
        id: "loop-parent-test",
        version: "1.0.0",
        description: "Loop parent contract test",
        capabilities: [capability(cap as any)],
        contributions: [],
      }),
      { generation: "gen-loop-parent" },
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
      invoke(method: PluginHostServiceMethod, params: Record<string, unknown>, actor?: object) {
        return executePluginHostService({
          pluginId: manifest.id,
          pluginDir: tmp.path,
          manifest,
          invocation: {
            scopeId: scope.id,
            sessionId: parentSessionID,
            directory: tmp.path,
            actor: (actor ?? { type: "lifecycle" }) as any,
          },
          method,
          params,
          signal: AbortSignal.timeout(5000),
        })
      },
    }
  }

  async function createWrongScopeSession(): Promise<{ sessionID: string; messageID: string }> {
    const otherTmp = await tmpdir({ git: true })
    const otherScope = await otherTmp.scope()
    let sessionID = ""
    let messageID = ""
    await ScopeContext.provide({
      scope: otherScope,
      fn: async () => {
        const session = await Session.create({})
        sessionID = session.id
        messageID = `msg-${session.id}`
        trackCleanup(session.id)
      },
    })
    return { sessionID, messageID }
  }

  // --- lifecycle + explicit parent → success ---

  test("lifecycle actor + explicit parent starts lightloop.start", async () => {
    const s = await setup(LIGHTLOOP_CAP)
    let error: Error | undefined
    try {
      await s.invoke(
        "lightloop.start",
        {
          parent: { sessionId: s.parentSessionID, messageId: s.parentMessageID },
          instructions: "test",
          correlationId: "c1",
          executionAgent: "nonexistent",
          reviewAgent: "nonexistent",
          budget: { maxRuntimeMs: 10000, maxIterations: 1 },
        },
        { type: "lifecycle" },
      )
    } catch (e: any) {
      error = e
    }
    expect(error?.message).not.toContain("requires a parent Session")
  })

  test("lifecycle actor + explicit parent starts blueprint.start", async () => {
    const s = await setup(BLUEPRINT_CAP)
    let error: Error | undefined
    try {
      await s.invoke(
        "blueprint.start",
        {
          parent: { sessionId: s.parentSessionID, messageId: s.parentMessageID },
          title: "test",
          markdown: "# test",
          sourceDigest: "abc",
          correlationId: "c1",
          executionAgent: "nonexistent",
          auditAgent: "nonexistent",
          budget: { maxRuntimeMs: 10000, maxIterations: 1 },
        },
        { type: "lifecycle" },
      )
    } catch (e: any) {
      error = e
    }
    expect(error?.message).not.toContain("requires a parent Session")
  })

  // --- lifecycle without parent → TASK_PARENT_REQUIRED ---

  test("lifecycle actor without parent throws TASK_PARENT_REQUIRED for lightloop.start", async () => {
    const s = await setup(LIGHTLOOP_CAP)
    await expect(
      s.invoke(
        "lightloop.start",
        {
          instructions: "test",
          correlationId: "c1",
          executionAgent: "nonexistent",
          reviewAgent: "nonexistent",
          budget: { maxRuntimeMs: 10000, maxIterations: 1 },
        },
        { type: "lifecycle" },
      ),
    ).rejects.toThrow("lightloop.start requires a parent Session and message")
  })

  test("lifecycle actor without parent throws TASK_PARENT_REQUIRED for blueprint.start", async () => {
    const s = await setup(BLUEPRINT_CAP)
    await expect(
      s.invoke(
        "blueprint.start",
        {
          title: "test",
          markdown: "# test",
          sourceDigest: "abc",
          correlationId: "c1",
          executionAgent: "nonexistent",
          auditAgent: "nonexistent",
          budget: { maxRuntimeMs: 10000, maxIterations: 1 },
        },
        { type: "lifecycle" },
      ),
    ).rejects.toThrow("blueprint.start requires a parent Session and message")
  })

  // --- wrong-scope parent → SCOPE_MISMATCH ---

  test("explicit parent from wrong scope throws SCOPE_MISMATCH for lightloop.start", async () => {
    const s = await setup(LIGHTLOOP_CAP)
    const wrong = await createWrongScopeSession()
    await expect(
      s.invoke(
        "lightloop.start",
        {
          parent: { sessionId: wrong.sessionID, messageId: wrong.messageID },
          instructions: "test",
          correlationId: "c1",
          executionAgent: "nonexistent",
          reviewAgent: "nonexistent",
          budget: { maxRuntimeMs: 10000, maxIterations: 1 },
        },
        { type: "lifecycle" },
      ),
    ).rejects.toThrow("parent Session does not belong to the active Scope")
  })

  test("explicit parent from wrong scope throws SCOPE_MISMATCH for blueprint.start", async () => {
    const s = await setup(BLUEPRINT_CAP)
    const wrong = await createWrongScopeSession()
    await expect(
      s.invoke(
        "blueprint.start",
        {
          parent: { sessionId: wrong.sessionID, messageId: wrong.messageID },
          title: "test",
          markdown: "# test",
          sourceDigest: "abc",
          correlationId: "c1",
          executionAgent: "nonexistent",
          auditAgent: "nonexistent",
          budget: { maxRuntimeMs: 10000, maxIterations: 1 },
        },
        { type: "lifecycle" },
      ),
    ).rejects.toThrow("parent Session does not belong to the active Scope")
  })

  // --- agent actor without parent → agent fallback ---

  test("agent actor without explicit parent uses invocation session+message for lightloop.start", async () => {
    const s = await setup(LIGHTLOOP_CAP)
    let error: Error | undefined
    try {
      await s.invoke(
        "lightloop.start",
        {
          instructions: "test",
          correlationId: "c1",
          executionAgent: "nonexistent",
          reviewAgent: "nonexistent",
          budget: { maxRuntimeMs: 10000, maxIterations: 1 },
        },
        { type: "agent", agent: "test-agent", messageId: "fallback-msg", callId: "call-1" },
      )
    } catch (e: any) {
      error = e
    }
    expect(error?.message).not.toContain("requires a parent Session")
  })

  test("agent actor without explicit parent uses invocation session+message for blueprint.start", async () => {
    const s = await setup(BLUEPRINT_CAP)
    let error: Error | undefined
    try {
      await s.invoke(
        "blueprint.start",
        {
          title: "test",
          markdown: "# test",
          sourceDigest: "abc",
          correlationId: "c1",
          executionAgent: "nonexistent",
          auditAgent: "nonexistent",
          budget: { maxRuntimeMs: 10000, maxIterations: 1 },
        },
        { type: "agent", agent: "test-agent", messageId: "fallback-msg", callId: "call-1" },
      )
    } catch (e: any) {
      error = e
    }
    expect(error?.message).not.toContain("requires a parent Session")
  })

  // --- explicit parent takes precedence over agent fallback ---

  test("explicit parent wins over agent actor fallback for lightloop.start", async () => {
    const s = await setup(LIGHTLOOP_CAP)
    const wrong = await createWrongScopeSession()
    await expect(
      s.invoke(
        "lightloop.start",
        {
          parent: { sessionId: wrong.sessionID, messageId: wrong.messageID },
          instructions: "test",
          correlationId: "c1",
          executionAgent: "nonexistent",
          reviewAgent: "nonexistent",
          budget: { maxRuntimeMs: 10000, maxIterations: 1 },
        },
        { type: "agent", agent: "test-agent", messageId: "fallback-msg", callId: "call-1" },
      ),
    ).rejects.toThrow("parent Session does not belong to the active Scope")
  })

  test("session.get rejects a Session from another Scope", async () => {
    const s = await setup(SESSION_READ_CAP)
    const wrong = await createWrongScopeSession()

    await expect(s.invoke("session.get", { sessionId: wrong.sessionID })).rejects.toMatchObject({
      name: "PluginHostServiceError",
      code: "PLUGIN_SESSION_SCOPE_MISMATCH",
    })
  })

  test("session.abort rejects a Session from another Scope", async () => {
    const s = await setup(SESSION_CONTROL_CAP)
    const wrong = await createWrongScopeSession()

    await expect(s.invoke("session.abort", { sessionId: wrong.sessionID })).rejects.toMatchObject({
      name: "PluginHostServiceError",
      code: "PLUGIN_SESSION_SCOPE_MISMATCH",
    })
  })

  // --- lightloop.get works from lifecycle ---

  test("lightloop.get works from lifecycle context", async () => {
    const s = await setup(LIGHTLOOP_CAP)
    let error: Error | undefined
    try {
      await s.invoke("lightloop.get", { sessionID: "ses_nonexistent_loop" }, { type: "lifecycle" })
    } catch (e: any) {
      error = e
    }
    expect(error?.message).not.toContain("agent invocation context")
    expect(error).toBeDefined()
  })
})
