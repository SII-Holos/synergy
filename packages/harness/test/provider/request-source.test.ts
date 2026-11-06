import { expect, test } from "bun:test"
import { Provider } from "../../src/provider/provider"
import { ProviderCatalogSource } from "../../src/provider/catalog-source"
import { ProviderRequestSource } from "../../src/provider/request-source"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { LLM } from "../../src/session/llm"
import { AgentTurnProtocol } from "../../src/session/agent-turn/protocol"
import { testRuntime } from "../support/runtime"

function provider() {
  return Provider.fromModelsDevProvider({
    id: "managed",
    name: "Managed",
    env: [],
    npm: "@ai-sdk/openai-compatible",
    api: "https://example.invalid/v1",
    models: {
      approved: {
        id: "approved",
        name: "Approved",
        release_date: "2026-10-01",
        attachment: false,
        reasoning: false,
        temperature: false,
        tool_call: true,
        limit: { context: 32000, output: 8000 },
        options: {},
      },
    },
  })
}

function input(commandID: string, signal = new AbortController().signal): LLM.StreamInput {
  return {
    user: {
      id: "msg_request_source",
      sessionID: "ses_request_source",
      role: "user",
      time: { created: 1 },
      agent: "managed-agent",
      model: { providerID: "managed", modelID: "approved" },
      isRoot: true,
      rootID: "msg_request_source",
      origin: { type: "user" },
      metadata: { commandID },
    },
    sessionID: "ses_request_source",
    model: provider().models.approved!,
    agent: { name: "managed-agent", mode: "primary", permission: [], options: {} },
    system: [],
    abort: signal,
    messages: [],
    tools: {},
  }
}

test("request credentials reach the worker plan without entering model parameters or the catalog", async () => {
  const catalog = provider()
  const requests: string[] = []
  await using runtime = await testRuntime({
    register() {
      ProviderCatalogSource.register({ providers: async () => ({ managed: catalog }) })
      ProviderRequestSource.register({
        async prepare(request) {
          const commandID = String(request.user.metadata?.commandID)
          requests.push(commandID)
          request.user.metadata!.commandID = "changed-copy"
          return { key: `fixture-${commandID}`, headers: { "x-request": commandID }, context: { commandID } }
        },
      })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      async fn() {
        for (const commandID of ["first", "second"]) {
          const request = input(commandID)
          const prepared = await LLM.prepare(request)
          const plan = AgentTurnProtocol.TurnInputSchema.shape.prepared.shape.provider.parse(prepared.provider)
          expect(plan.key).toBe(`fixture-${commandID}`)
          expect(plan.options.headers).toEqual({ "x-request": commandID })
          expect(plan.options.hostRequest).toEqual({ commandID })
          expect(plan.authoritative).toBe(true)
          expect(prepared.params.options.hostRequest).toBeUndefined()
          expect(request.user.metadata?.commandID).toBe(commandID)
        }
        expect((await Provider.list()).managed?.key).toBeUndefined()
        expect(catalog.options.hostRequest).toBeUndefined()
        expect(() => ProviderRequestSource.register({ prepare: async () => ({}) })).toThrow(
          "before opening the Runtime",
        )
      },
    }),
  )
  expect(requests).toEqual(["first", "second"])
})

test("request source failures and cancellation prevent preparation", async () => {
  const controller = new AbortController()
  let calls = 0
  await using runtime = await testRuntime({
    register() {
      ProviderCatalogSource.register({ providers: async () => ({ managed: provider() }) })
      ProviderRequestSource.register({
        async prepare(request) {
          calls++
          if (request.user.metadata?.commandID === "cancel") {
            controller.abort()
            return { key: "fixture-key" }
          }
          throw new Error("host authorization failed")
        },
      })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      async fn() {
        await expect(LLM.prepare(input("denied"))).rejects.toThrow("Host provider request preparation failed")
        await expect(LLM.prepare(input("cancel", controller.signal))).rejects.toMatchObject({ name: "AbortError" })
        await expect(LLM.prepare(input("already-aborted", controller.signal))).rejects.toMatchObject({
          name: "AbortError",
        })
      },
    }),
  )
  expect(calls).toBe(2)
})

test("request sources are isolated and unconfigured runtimes retain their provider plans", async () => {
  await using configured = await testRuntime({
    register() {
      ProviderRequestSource.register({ prepare: async () => ({ key: "fixture-selected" }) })
    },
  })
  await using unconfigured = await testRuntime()
  const plan: Provider.WorkerPlan = { options: {}, timeouts: { ttfbMs: 1000, idleMs: false, wallMs: false } }
  expect((await configured.run(() => ProviderRequestSource.prepare(input("first"), plan))).key).toBe("fixture-selected")
  expect(await unconfigured.run(() => ProviderRequestSource.prepare(input("second"), plan))).toBe(plan)
})

test("request context rejects non-serializable values before worker handoff", async () => {
  await using runtime = await testRuntime({
    register() {
      ProviderRequestSource.register({ prepare: async () => ({ context: { invalid: () => "not-json" } }) })
    },
  })
  await expect(
    runtime.run(() =>
      ProviderRequestSource.prepare(input("invalid"), {
        options: {},
        timeouts: { ttfbMs: 1000, idleMs: false, wallMs: false },
      }),
    ),
  ).rejects.toThrow("Host provider request preparation failed")
})
