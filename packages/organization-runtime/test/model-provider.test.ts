import { expect, test } from "bun:test"
import { OrganizationGatewayProtocol as Gateway } from "@ericsanchezok/synergy-organization-protocol"
import { AgentTurn } from "@ericsanchezok/synergy-harness/session/agent-turn"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { RolloutArtifact } from "@ericsanchezok/synergy-harness/session/rollout/artifact"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { ProviderSdkSource } from "@ericsanchezok/synergy-harness/provider/sdk-source"
import { Provider } from "@ericsanchezok/synergy-harness/provider/provider"
import { openMemberRuntime } from "../src/runtime"
import { createMemberModelProvider, MemberModelContext } from "../src/model-provider"
import { executionFixture } from "./support/execution"

function response(protocol: Gateway.ModelProtocol) {
  const model = "fixture-model"
  const events =
    protocol === "openai-compatible"
      ? [
          {
            id: "chatcmpl-test",
            created: 1,
            model,
            choices: [{ index: 0, delta: { content: "Member answer" }, finish_reason: null }],
          },
          {
            id: "chatcmpl-test",
            created: 1,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
          },
        ]
      : [
          {
            type: "message_start",
            message: {
              id: "msg_test",
              type: "message",
              role: "assistant",
              model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 4, output_tokens: 0 },
            },
          },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Member answer" } },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 2 },
          },
          { type: "message_stop" },
        ]
  return new Response(
    events
      .map((event) => `${"type" in event ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`)
      .join("") + (protocol === "openai-compatible" ? "data: [DONE]\n\n" : ""),
    { headers: { "content-type": "text/event-stream" } },
  )
}

for (const protocol of ["openai-compatible", "anthropic-compatible"] as const)
  test(`${protocol} member workers use finite capabilities while preserving transport evidence`, async () => {
    const observed: Array<{ path: string; authorization: string | null; apiKey: string | null; body: unknown }> = []
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        observed.push({
          path: new URL(request.url).pathname,
          authorization: request.headers.get("authorization"),
          apiKey: request.headers.get("x-api-key"),
          body: await request.json(),
        })
        return response(protocol)
      },
    })
    try {
      await using f = await executionFixture({ protocol, endpoint: new URL("/v1", upstream.url).href })
      const description = await f.connection.resources.describe(await f.description())
      const provider = createMemberModelProvider(description.resources[0]!, f.origin)
      const grant = await f.connection.resources.bind(await f.binding())
      await using runtime = await openMemberRuntime({
        home: f.member.home,
        identity: f.member.identity,
        environment: {
          ...process.env,
          OPENAI_API_KEY: "personal-key-excluded",
          ANTHROPIC_API_KEY: "personal-key-excluded",
        },
      })
      await runtime.run(() =>
        ScopeContext.provide({
          scope: Scope.home(),
          async fn() {
            AgentTurn.configure({ size: 1, minIdle: 0 })
            for (const callID of ["first", "second"]) {
              const capability = await f.connection.resources.reserve(f.proof(grant, callID))
              const operationID = crypto.randomUUID()
              const owner = { kind: "operation" as const, scopeID: "home", operationID }
              const key = Gateway.encode(capability)
              const prepared = {
                system: [],
                baseSystemLength: 0,
                params: { options: {} },
                provider: {
                  authoritative: true,
                  env: [],
                  key,
                  options: {
                    hostRequest: MemberModelContext.parse({
                      schemaVersion: 1,
                      purpose: "organization-model",
                      origin: f.origin,
                      signingIdentity: f.connection.connected.signingIdentity,
                      ca: f.ca,
                    }),
                  },
                  timeouts: { ttfbMs: 2000, idleMs: 2000, wallMs: 5000 },
                },
              }
              const stream = await AgentTurn.stream({
                sessionID: f.sessionID,
                user: {
                  id: grant.rootID,
                  sessionID: f.sessionID,
                  role: "user",
                  time: { created: 1 },
                  agent: "organization-fixture",
                  model: { providerID: provider.id, modelID: "fixture-model" },
                  isRoot: true,
                  rootID: grant.rootID,
                  origin: { type: "user" },
                },
                agent: { name: "organization-fixture", mode: "primary", permission: [], options: {} },
                model: provider.models["fixture-model"]!,
                system: [],
                messages: [{ role: "user", content: "A member request" }],
                abort: new AbortController().signal,
                toolDefinitions: [],
                prepared,
                recording: { owner, runID: operationID, purpose: "member-provider-test" },
                usageRole: "conversation",
              })
              let text = ""
              try {
                for await (const part of stream.fullStream) {
                  if (part.type === "error") throw part.error
                  if (part.type === "text-delta") text += part.text
                }
                expect(text).toBe("Member answer")
                expect(await stream.usage).toMatchObject({ inputTokens: 4, outputTokens: 2 })
              } finally {
                await stream.dispose()
              }
              const calls = await RolloutLedger.calls(owner, operationID)
              expect(calls).toMatchObject([{ status: "completed", transportCaptured: true }])
              const chunks: Uint8Array[] = []
              for await (const chunk of RolloutArtifact.read(owner, calls[0]!.request!.id)) chunks.push(chunk)
              const retained = Buffer.concat(chunks).toString()
              expect(retained).not.toContain(key)
              expect(retained).not.toContain("private-upstream-key")
              expect(await f.connection.resources.inspect(f.proof(grant, callID))).toMatchObject({
                state: "response_complete",
              })
            }
            expect(AgentTurn.stats()).toMatchObject({ workers: 1, active: 0, queued: 0 })
          },
        }),
      )
      expect(observed).toHaveLength(2)
      for (const request of observed) {
        expect(request.path).toBe(protocol === "openai-compatible" ? "/v1/chat/completions" : "/v1/messages")
        expect(request.authorization).toBe(protocol === "openai-compatible" ? "Bearer private-upstream-key" : null)
        expect(request.apiKey).toBe(protocol === "anthropic-compatible" ? "private-upstream-key" : null)
        expect(request.body).toMatchObject({ model: "fixture-model", stream: true })
      }
    } finally {
      await upstream.stop(true)
    }
  })

test("member SDKs reject missing, changed, expired and reused authority before their transport", async () => {
  await using f = await executionFixture()
  const description = await f.connection.resources.describe(await f.description())
  const provider = createMemberModelProvider(description.resources[0]!, f.origin)
  const grant = await f.connection.resources.bind(await f.binding())
  const capability = await f.connection.resources.reserve(f.proof(grant, "validation"))
  await using runtime = await openMemberRuntime({ home: f.member.home, identity: f.member.identity })
  await runtime.run(async () => {
    const factory = ProviderSdkSource.loadSync("@ai-sdk/openai-compatible")
    const context = MemberModelContext.parse({
      schemaVersion: 1,
      purpose: "organization-model",
      origin: f.origin,
      signingIdentity: f.connection.connected.signingIdentity,
      ca: f.ca,
    })
    const sent: Array<{ url: string; init: RequestInit | undefined }> = []
    const options = {
      name: provider.id,
      baseURL: provider.models["fixture-model"]!.api.url,
      apiKey: Gateway.encode(capability),
      hostRequest: context,
      async fetch(input: RequestInfo | URL, init?: RequestInit) {
        sent.push({ url: input instanceof Request ? input.url : input.toString(), init })
        return Response.json({
          id: "chatcmpl-direct",
          created: 1,
          model: "fixture-model",
          choices: [{ index: 0, message: { role: "assistant", content: "Direct answer" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        })
      },
    }
    const prompt = [{ role: "user" as const, content: [{ type: "text" as const, text: "A private request" }] }]
    const language = (options: Record<string, unknown>) => {
      const model = factory(options).languageModel("fixture-model")
      if (typeof model === "string") throw new Error("Member SDK must resolve a concrete language model")
      return model
    }
    await expect(ProviderSdkSource.load("@ai-sdk/openai")).rejects.toThrow("Unsupported provider SDK")
    for (const change of [
      { hostRequest: undefined },
      { apiKey: "personal-key-excluded" },
      { name: "another-provider" },
      { baseURL: "https://foreign.invalid/v1" },
      { hostRequest: { ...context, signingIdentity: { ...context.signingIdentity, orgID: "another-org" } } },
    ])
      expect(() => factory({ ...options, ...change })).toThrow()
    const anthropic = await ProviderSdkSource.load("@ai-sdk/anthropic")
    expect(() => anthropic(options)).toThrow("selected provider")
    const invalid = language({ ...options, apiKey: Gateway.encode({ ...capability, signature: "0".repeat(128) }) })
    await expect(invalid.doGenerate({ prompt })).rejects.toThrow("signature")
    const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
    const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", keys.publicKey)).toString("hex")
    for (const [issuedAt, expiresAt] of [
      [Date.now() - 2000, Date.now() - 1000],
      [Date.now() + 10_000, Date.now() + 20_000],
    ]) {
      const permit = { ...capability.permit, issuedAt: issuedAt!, expiresAt: expiresAt! }
      const model = language({
        ...options,
        apiKey: Gateway.encode({ permit, signature: await Gateway.signPermit(permit, keys.privateKey) }),
        hostRequest: { ...context, signingIdentity: { ...context.signingIdentity, publicKey } },
      })
      await expect(model.doGenerate({ prompt })).rejects.toThrow("expired")
    }
    const cancelled = language(options)
    await expect(cancelled.doGenerate({ prompt, abortSignal: AbortSignal.abort() })).rejects.toThrow()
    expect(sent).toHaveLength(0)
    const mutable = { ...options }
    const valid = language(mutable)
    mutable.apiKey = "changed-after-preparation"
    const call = {
      prompt,
      headers: {
        cookie: "personal-cookie",
        origin: "https://personal.invalid",
        authorization: "Bearer personal-key-excluded",
        "x-extra": "private-header",
      },
    }
    await valid.doGenerate(call)
    await expect(valid.doGenerate(call)).rejects.toMatchObject({
      data: { code: "REVISION_CONFLICT", outcome: "unknown", retryable: false },
    })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.init).toMatchObject({
      proxy: false,
      credentials: "omit",
      redirect: "error",
      tls: { ca: f.ca, rejectUnauthorized: true },
    })
    const headers = new Headers(sent[0]!.init?.headers)
    expect(headers.get("authorization")).toBe(`Bearer ${options.apiKey}`)
    for (const name of ["cookie", "origin", "x-extra"]) expect(headers.has(name)).toBe(false)
  })
})

test("cancelling a member worker drains its real gateway stream without replay", async () => {
  const cancelled = Promise.withResolvers<void>()
  let requests = 0
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      await request.json()
      requests++
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ id: "chatcmpl-held", created: 1, model: "fixture-model", choices: [{ index: 0, delta: { content: "Partial answer" }, finish_reason: null }] })}\n\n`,
              ),
            )
          },
          cancel() {
            cancelled.resolve()
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  try {
    await using f = await executionFixture({ endpoint: new URL("/v1", upstream.url).href })
    const provider = createMemberModelProvider(
      (await f.connection.resources.describe(await f.description())).resources[0]!,
      f.origin,
    )
    const grant = await f.connection.resources.bind(await f.binding())
    const capability = await f.connection.resources.reserve(f.proof(grant, "cancelled-worker"))
    await using runtime = await openMemberRuntime({ home: f.member.home, identity: f.member.identity })
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        async fn() {
          AgentTurn.configure({ size: 1, minIdle: 0 })
          const abort = new AbortController()
          const operationID = crypto.randomUUID()
          const owner = { kind: "operation" as const, scopeID: "home", operationID }
          const stream = await AgentTurn.stream({
            sessionID: f.sessionID,
            user: {
              id: grant.rootID,
              sessionID: f.sessionID,
              role: "user",
              time: { created: 1 },
              agent: "fixture",
              model: { providerID: provider.id, modelID: "fixture-model" },
              isRoot: true,
              rootID: grant.rootID,
              origin: { type: "user" },
            },
            agent: { name: "fixture", mode: "primary", permission: [], options: {} },
            model: provider.models["fixture-model"]!,
            system: [],
            messages: [{ role: "user", content: "A cancellable request" }],
            abort: abort.signal,
            toolDefinitions: [],
            prepared: {
              system: [],
              baseSystemLength: 0,
              params: { options: {} },
              provider: {
                authoritative: true,
                env: [],
                key: Gateway.encode(capability),
                options: {
                  hostRequest: MemberModelContext.parse({
                    schemaVersion: 1,
                    purpose: "organization-model",
                    origin: f.origin,
                    signingIdentity: f.connection.connected.signingIdentity,
                    ca: f.ca,
                  }),
                },
                timeouts: { ttfbMs: 2000, idleMs: 5000, wallMs: 5000 },
              },
            },
            recording: { owner, runID: operationID, purpose: "member-provider-cancellation" },
            usageRole: "conversation",
          })
          const received = Promise.withResolvers<void>()
          const consume = (async () => {
            for await (const part of stream.fullStream) {
              if (part.type === "error") throw part.error
              if (part.type === "text-delta") received.resolve()
            }
          })()
          const outcome = Promise.allSettled([consume])
          try {
            await Promise.race([
              received.promise,
              consume.then(() => {
                throw new Error("Model stopped before its first delta")
              }),
            ])
            abort.abort(new Error("Stop the held member call"))
            await outcome
            expect(await Promise.allSettled([stream.dispose()])).toMatchObject([
              { status: "rejected", reason: { name: "AbortError" } },
            ])
            await cancelled.promise
            expect(requests).toBe(1)
            expect(AgentTurn.stats()).toMatchObject({ active: 0, queued: 0 })
            expect(await f.connection.resources.inspect(f.proof(grant, "cancelled-worker"))).toMatchObject({
              state: "unknown",
            })
            const calls = await RolloutLedger.calls(owner, operationID)
            expect(calls).toMatchObject([{ status: "failed", response: { status: "partial" }, sdkUsage: null }])
            expect(await RolloutLedger.attempts(owner, operationID, calls[0]!.id)).toMatchObject([
              { request: { status: "complete" }, response: { status: "partial" }, usageFinal: false },
            ])
          } finally {
            abort.abort()
            await outcome
            await Promise.allSettled([stream.dispose()])
          }
        },
      }),
    )
  } finally {
    await upstream.stop(true)
  }
})

test("the recorded provider transport verifies deployment trust and rejects redirects without private fallback", async () => {
  await using f = await executionFixture()
  const provider = createMemberModelProvider(
    (await f.connection.resources.describe(await f.description())).resources[0]!,
    f.origin,
  )
  const grant = await f.connection.resources.bind(await f.binding())
  const capability = await f.connection.resources.reserve(f.proof(grant, "transport-failure"))
  let calls = 0
  let redirected = 0
  f.interceptHTTP((request) => {
    const url = new URL(request.url)
    if (url.pathname === "/redirected") {
      redirected++
      return Response.json({ leaked: true })
    }
    if (!url.pathname.startsWith("/runtime/v1/gateway/models/")) return
    calls++
    return Response.redirect(new URL("/redirected", f.origin), 307)
  })
  await using runtime = await openMemberRuntime({ home: f.member.home, identity: f.member.identity })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      async fn() {
        const prepare = (ca?: string) =>
          Provider.getLanguage(provider.models["fixture-model"]!, {
            authoritative: true,
            key: Gateway.encode(capability),
            env: [],
            options: {
              hostRequest: MemberModelContext.parse({
                schemaVersion: 1,
                purpose: "organization-model",
                origin: f.origin,
                signingIdentity: f.connection.connected.signingIdentity,
                ca,
              }),
            },
            timeouts: { ttfbMs: 2000, idleMs: 2000, wallMs: 5000 },
          })
        const prompt = [{ role: "user" as const, content: [{ type: "text" as const, text: "Private request" }] }]
        const untrusted = await prepare()
        if (typeof untrusted === "string") throw new Error("Expected a concrete provider")
        await expect(untrusted.doGenerate({ prompt })).rejects.toThrow()
        expect(calls).toBe(0)
        const trusted = await prepare(f.ca)
        if (typeof trusted === "string") throw new Error("Expected a concrete provider")
        await expect(trusted.doGenerate({ prompt })).rejects.toThrow()
        expect(calls).toBe(1)
        expect(redirected).toBe(0)
        await expect(trusted.doGenerate({ prompt })).rejects.toMatchObject({ data: { outcome: "unknown" } })
        expect(calls).toBe(1)
        expect(await Provider.list()).toEqual({})
      },
    }),
  )
})
