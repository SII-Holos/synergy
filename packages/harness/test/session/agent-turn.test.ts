import { expect, mock, test } from "bun:test"
import { AgentTurn } from "../../src/session/agent-turn"
import { runInProcessStream } from "../../src/session/agent-turn/in-process"
import { AgentWorkerPool } from "../../src/session/agent-turn/worker-pool"
import { ContextUsage } from "../../src/session/context-usage"
import { LLM } from "../../src/session/llm"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { RolloutArtifact } from "../../src/session/rollout/artifact"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
import { SecretVault } from "../../src/secrets/vault"
import { SecretMask } from "../../src/secrets/mask"
const runtime = await testRuntime()

test("starts Context Usage estimation only after the Agent worker starts", () =>
  runtime.run(async () => {
    const originalPrepare = LLM.prepare
    const originalRun = AgentWorkerPool.prototype.run
    const originalMeasureDraft = ContextUsage.measureDraft
    const started = Promise.withResolvers<AgentTurn.Stream>()
    let estimationStarts = 0
    let measured: Parameters<typeof ContextUsage.measureDraft>[0] | undefined
    const operationID = crypto.randomUUID()

    try {
      await AgentTurn.stop()
      AgentTurn.configure({ minIdle: 0 })
      AgentTurn.setInProcessStream(undefined)
      ;(LLM.prepare as any) = mock(async () => ({
        system: ["prepared system"],
        baseSystemLength: 1,
        provider: {
          options: {},
          timeouts: { ttfbMs: 1_000, idleMs: false, wallMs: false },
        },
        params: { options: {} },
      }))
      ;(AgentWorkerPool.prototype.run as any) = mock(() => started.promise)
      ;(ContextUsage.measureDraft as any) = mock(async (input: Parameters<typeof ContextUsage.measureDraft>[0]) => {
        estimationStarts++
        measured = input
        return undefined
      })

      const pending = AgentTurn.stream({
        user: { id: "msg_user" },
        sessionID: "ses_test",
        recording: { owner: { kind: "operation", scopeID: "home", operationID }, runID: operationID, purpose: "test" },
        model: {
          id: "test-model",
          providerID: "test-provider",
          api: { id: "test-model", npm: "@ai-sdk/openai" },
          limit: { context: 4096, output: 1024 },
        },
        agent: { name: "synergy" },
        system: [],
        messages: [{ role: "user", content: "final transformed input" }],
        abort: new AbortController().signal,
        toolDefinitions: [
          { id: "visible", description: "visible tool", inputSchema: { type: "object" } },
          { id: "hidden", description: "hidden tool", inputSchema: { type: "object" } },
        ],
        activeToolIDs: ["visible"],
        contextUsageProvenance: {
          categories: {
            userMessages: [{ text: "queued prompt" }],
            toolResults: [],
            attachments: [],
            systemInstructions: [],
            assistantMessages: [],
            toolDefinitions: [],
            injectedContext: [],
            skills: [],
          },
          items: {
            userMessages: 1,
            toolResults: 0,
            attachments: 0,
            systemInstructions: 0,
            assistantMessages: 0,
            toolDefinitions: 0,
            injectedContext: 0,
            skills: 0,
          },
        },
      } as any)

      await Bun.sleep(0)
      expect(estimationStarts).toBe(0)

      started.resolve({
        fullStream: (async function* () {})(),
        usage: Promise.resolve(undefined),
        async dispose() {},
      })
      const stream = await pending

      const calls = await RolloutLedger.calls({ kind: "operation", scopeID: "home", operationID }, operationID)
      expect(calls.map((call) => call.usageRole)).toEqual(["auxiliary"])

      expect(estimationStarts).toBe(1)
      expect(measured?.provenance.categories.userMessages.map((entry) => entry.text)).toEqual([
        "final transformed input",
      ])
      expect(measured?.provenance.items.toolDefinitions).toBe(1)
      const chunks: Uint8Array[] = []
      for await (const chunk of RolloutArtifact.read(calls[0].owner, calls[0].request.id)) chunks.push(chunk)
      const recorded = JSON.parse(Buffer.concat(chunks).toString())
      expect(recorded.tools.map((tool: { id: string }) => tool.id)).toEqual(["visible"])
      expect(
        recorded.contextSources.find((entry: { category: string }) => entry.category === "userMessages").characters,
      ).toBe("final transformed input".length)
      expect(stream.contextUsageDraft).toBeDefined()
      await stream.contextUsageDraft
      await stream.dispose()
    } finally {
      ;(LLM.prepare as any) = originalPrepare
      ;(AgentWorkerPool.prototype.run as any) = originalRun
      ;(ContextUsage.measureDraft as any) = originalMeasureDraft
      AgentTurn.setInProcessStream(runInProcessStream)
      await AgentTurn.stop()
      AgentTurn.configure()
    }
  }))

test("reuses a prepared request without rerunning final prompt or parameter hooks", () =>
  runtime.run(async () => {
    const originalPrepare = LLM.prepare
    const originalRun = AgentWorkerPool.prototype.run
    const operationID = crypto.randomUUID()
    const secret = `fixture-${crypto.randomUUID()}`
    const entry = await SecretVault.register(secret, { kind: "user" })
    let receivedSuffix: string | undefined
    const prepared: LLM.PreparedTurn = {
      system: ["stable final system"],
      baseSystemLength: 1,
      provider: { options: {}, timeouts: { ttfbMs: 1_000, idleMs: false, wallMs: false } },
      params: { temperature: 0.7, options: { reasoningEffort: "high" } },
    }
    let received: unknown
    const prepare = mock(async () => {
      throw new Error("Final preparation must not run twice")
    })
    try {
      await AgentTurn.stop()
      AgentTurn.configure({ minIdle: 0 })
      AgentTurn.setInProcessStream(undefined)
      LLM.prepare = prepare
      AgentWorkerPool.prototype.run = mock(async (input) => {
        received = input.prepared
        receivedSuffix = input.promptSuffix
        return { fullStream: (async function* () {})(), usage: Promise.resolve(undefined), async dispose() {} }
      })
      const stream = await AgentTurn.stream({
        user: {
          id: "msg_user",
          sessionID: "ses_test",
          role: "user",
          time: { created: 0 },
          agent: "synergy",
          model: { providerID: "test-provider", modelID: "test-model" },
        },
        sessionID: "ses_test",
        recording: { owner: { kind: "operation", scopeID: "home", operationID }, runID: operationID, purpose: "test" },
        model: {
          id: "test-model",
          providerID: "test-provider",
          api: { id: "test-model", url: "https://fixture.invalid", npm: "@ai-sdk/openai" },
          limit: { context: 4096, output: 1024 },
          name: "Fixture",
          status: "active",
          options: {},
          headers: {},
          release_date: "2026-01-01",
          capabilities: {
            temperature: true,
            reasoning: false,
            attachment: false,
            toolcall: true,
            input: { text: true, image: false, audio: false, video: false, pdf: false },
            output: { text: true, image: false, audio: false, video: false, pdf: false },
            interleaved: false,
          },
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        },
        agent: { name: "synergy", mode: "primary", permission: [], options: {} },
        system: ["caller system"],
        messages: [{ role: "user", content: "summarize" }],
        abort: new AbortController().signal,
        toolDefinitions: [],
        prepared,
        promptSuffix: `Summary instructions ${secret}`,
      })
      expect(prepare).not.toHaveBeenCalled()
      expect(received).toBe(prepared)
      expect(receivedSuffix).toBe(`Summary instructions ${SecretMask.token(entry.id)}`)
      const owner = { kind: "operation" as const, scopeID: "home", operationID }
      const [call] = await RolloutLedger.calls(owner, operationID)
      const chunks: Uint8Array[] = []
      for await (const chunk of RolloutArtifact.read(owner, call.request.id)) chunks.push(chunk)
      const evidence = Buffer.concat(chunks).toString()
      expect(evidence).not.toContain(secret)
      expect(evidence).toContain(SecretMask.token(entry.id))
      await stream.dispose()
    } finally {
      LLM.prepare = originalPrepare
      AgentWorkerPool.prototype.run = originalRun
      AgentTurn.setInProcessStream(runInProcessStream)
      await AgentTurn.stop()
      AgentTurn.configure()
      await SecretVault.remove(entry.id)
    }
  }))

test("prewarm creates the worker pool eagerly and stays a no-op for the in-process adapter", () =>
  runtime.run(async () => {
    try {
      await AgentTurn.stop()
      AgentTurn.configure({ size: 1, minIdle: 0 })
      AgentTurn.setInProcessStream(undefined)
      expect(AgentTurn.stats()).toMatchObject({ configured: 1, workers: 0, active: 0 })

      AgentTurn.prewarm()
      expect(() => AgentTurn.configure()).toThrow("cannot be reconfigured")
      expect(AgentTurn.stats()).toMatchObject({ configured: 1, workers: 0, active: 0 })

      await AgentTurn.stop()
      AgentTurn.configure({ size: 1, minIdle: 0 })
      AgentTurn.setInProcessStream(runInProcessStream)
      AgentTurn.prewarm()
      expect(() => AgentTurn.configure()).not.toThrow()
    } finally {
      AgentTurn.setInProcessStream(runInProcessStream)
      await AgentTurn.stop()
      AgentTurn.configure()
    }
  }))

afterRuntimeTests(() => runtime.close())
